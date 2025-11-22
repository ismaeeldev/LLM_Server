import { YoutubeLoader } from "@langchain/community/document_loaders/web/youtube";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import { PineconeStore } from "@langchain/pinecone";
import { Pinecone as PineconeClient } from "@pinecone-database/pinecone";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import dotenv from "dotenv";
import { setTimeout } from "timers/promises";

dotenv.config();

// Configuration constants
const DEFAULT_CONFIG = {
    modelName: "gpt-3.5-turbo",
    temperature: 0.2,
    embeddingModel: "text-embedding-3-small",
    chunkSize: 1000,
    chunkOverlap: 150, // 15% of 1000
    maxRetries: 3,
    retryDelay: 2000,
    maxConcurrency: 5,
    topK: 6,
    cacheTTL: 24 * 60 * 60 * 1000, // 24 hours
};

// Simple in-memory cache for embeddings/namespaces (Production should use Redis)
const embeddingCache = new Map();

/**
 * Checks if a namespace exists in Pinecone and is fresh
 * @param {PineconeClient.Index} index 
 * @param {string} namespace 
 * @returns {Promise<boolean>}
 */
async function namespaceExists(index, namespace) {
    try {
        // Check local cache first
        if (embeddingCache.has(namespace)) {
            const timestamp = embeddingCache.get(namespace);
            if (Date.now() - timestamp < DEFAULT_CONFIG.cacheTTL) {
                return true;
            }
        }

        const stats = await index.describeIndexStats();
        const exists = stats.namespaces && stats.namespaces[namespace] !== undefined;

        if (exists) {
            embeddingCache.set(namespace, Date.now());
        }
        return exists;
    } catch (error) {
        console.error("Error checking namespace existence:", error);
        return false;
    }
}

/**
 * Processes YouTube video transcript and answers questions
 * @param {string} videoUrl - YouTube video URL
 * @param {string} query - User question
 * @param {object} context - Video context (title, description, timestamp)
 * @param {object} config - Optional configuration overrides
 * @returns {Promise<{question: string, answer: string, contextChunks: Array}>}
 */
export async function askYoutube(videoUrl, query, context = {}, config = {}) {
    const finalConfig = { ...DEFAULT_CONFIG, ...config };
    const videoId = new URL(videoUrl).searchParams.get("v");

    if (!videoId) {
        throw new Error("Invalid YouTube URL - no video ID found");
    }

    // === 1. Init LLM & Embeddings ===
    const parser = new StringOutputParser();

    // Multi-LLM Fallback Strategy
    let model;
    try {
        model = new ChatOpenAI({
            modelName: finalConfig.modelName,
            temperature: finalConfig.temperature,
            openAIApiKey: process.env.OPENAI_API_KEY
        });
    } catch (e) {
        console.warn("OpenAI init failed, trying TogetherAI...");
        // Placeholder for TogetherAI or other fallback
        // model = new ChatTogetherAI({ ... });
        throw new Error("Primary LLM failed and no fallback configured.");
    }

    const embeddings = new OpenAIEmbeddings({
        model: finalConfig.embeddingModel,
    });

    // === 2. Pinecone Setup ===
    const pinecone = new PineconeClient();
    const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX);
    const namespace = `yt-${videoId}`;

    // Check if namespace exists to avoid re-processing
    const exists = await namespaceExists(pineconeIndex, namespace);

    if (!exists) {
        console.log(`Processing new video: ${videoId}`);

        // === 3. Load Transcript ===
        // Try to use the provided transcript if available (from client), else fetch
        let docs = [];
        if (context.transcript) {
            docs = [new Document({ pageContent: context.transcript, metadata: { source: videoUrl } })];
        } else {
            try {
                const loader = YoutubeLoader.createFromUrl(videoUrl, {
                    language: "en",
                    addVideoInfo: true,
                });
                docs = await loader.load();
            } catch (e) {
                console.error("YoutubeLoader failed:", e);
                throw new Error("Could not retrieve transcript. Please ensure the video has captions.");
            }
        }

        if (!docs.length || !docs[0].pageContent.trim()) {
            throw new Error("Transcript not found or is empty.");
        }

        // === 4. Split Transcript (Smart Chunking) ===
        const textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: finalConfig.chunkSize,
            chunkOverlap: finalConfig.chunkOverlap,
            separators: ["\n\n", "\n", ". ", "! ", "? ", " ", ""], // Semantic boundaries
        });

        const textChunks = await textSplitter.splitText(docs[0].pageContent);
        const documents = textChunks.map(
            (chunk, index) => new Document({
                pageContent: chunk,
                metadata: {
                    source: videoUrl,
                    videoId,
                    chunkIndex: index,
                    timestamp: new Date().toISOString(),
                }
            })
        );

        // === 5. Store in Pinecone with retries ===
        const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
            pineconeIndex,
            maxConcurrency: finalConfig.maxConcurrency,
            namespace,
        });

        let attempts = 0;
        while (attempts < finalConfig.maxRetries) {
            try {
                await vectorStore.addDocuments(documents);
                embeddingCache.set(namespace, Date.now()); // Update cache
                await setTimeout(finalConfig.retryDelay);
                break;
            } catch (error) {
                attempts++;
                console.warn(`Pinecone add failed (attempt ${attempts}):`, error.message);
                if (attempts === finalConfig.maxRetries) throw error;
                await setTimeout(finalConfig.retryDelay * attempts);
            }
        }
    }

    // === 6. Retrieve Relevant Chunks ===
    const vectorStore = await PineconeStore.fromExistingIndex(embeddings, {
        pineconeIndex,
        namespace,
    });

    const retriever = vectorStore.asRetriever({
        k: finalConfig.topK,
    });

    const results = await retriever.invoke(query);

    if (!results.length) {
        return "I couldn't find any relevant information in the video to answer your question.";
    }

    const PromptContext = results
        .map((doc) => `[Context Chunk]: ${doc.pageContent}`)
        .join("\n\n");

    // === 7. Prompt with Context Injection ===
    const systemPrompt = `You are an expert YouTube video assistant.
    
    VIDEO CONTEXT:
    Title: ${context.title || "Unknown"}
    Description: ${context.description || "None"}
    Current User Timestamp: ${context.timestamp ? Math.floor(context.timestamp) + "s" : "Start"}
    
    INSTRUCTIONS:
    1. Answer the user's question based STRICTLY on the provided video context chunks.
    2. If the answer is not in the context, say "I cannot find the answer in this video."
    3. Use a friendly, helpful tone.
    4. If relevant, mention if the user is currently at a part of the video related to the topic (based on timestamp).
    5. Format your answer with Markdown.
    6. CITE YOUR SOURCES: When using information, try to estimate the timestamp if possible (e.g., [05:30]) based on the context flow, or at least quote the specific phrase.
    
    CONTEXT CHUNKS:
    ${PromptContext}`;

    const Prompt = ChatPromptTemplate.fromMessages([
        ["system", systemPrompt],
        ["user", "{query}"]
    ]);

    // === 8. Run Chain ===
    const chain = Prompt.pipe(model).pipe(parser);

    // Return the chain for streaming, or await it for blocking
    return chain;
}

