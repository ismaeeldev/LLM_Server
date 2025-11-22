// server.js
// Local Express server to run askYoutube logic for Chrome extension (ESM version)

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import https from "https";

// __dirname replacement in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' })); // Increased limit for transcripts

// Default route - show server status
app.get("/", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>YouTube AI Server</title>
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    max-width: 800px; 
                    margin: 0 auto; 
                    padding: 40px 20px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    text-align: center;
                }
                .container {
                    background: rgba(255, 255, 255, 0.1);
                    padding: 40px;
                    border-radius: 15px;
                    backdrop-filter: blur(10px);
                }
                h1 { 
                    font-size: 2.5em; 
                    margin-bottom: 20px;
                    text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
                }
                .status {
                    background: #4CAF50;
                    color: white;
                    padding: 10px 20px;
                    border-radius: 25px;
                    display: inline-block;
                    font-weight: bold;
                    margin: 20px 0;
                }
                .endpoints {
                    text-align: left;
                    background: rgba(255, 255, 255, 0.2);
                    padding: 20px;
                    border-radius: 10px;
                    margin: 30px 0;
                }
                code {
                    background: rgba(0, 0, 0, 0.3);
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-family: 'Courier New', monospace;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🎥 YouTube AI Server</h1>
                <div class="status">🟢 Server is running moody</div>
                
                <div class="endpoints">
                    <h3>📡 Available Endpoints:</h3>
                    <p><strong>GET</strong> <code>/</code> - This status page</p>
                    <p><strong>GET</strong> <code>/health</code> - Health check</p>
                    <p><strong>POST</strong> <code>/ask-youtube</code> - Ask questions about YouTube videos</p>
                </div>
                
                <p>Server time: ${new Date().toLocaleString()}</p>
                <p>Ready to process YouTube queries! 🚀</p>
            </div>
        </body>
        </html>
    `);
});
// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Main ask-youtube route
app.post("/ask-youtube", async (req, res) => {
    const { videoUrl, query, title, description, timestamp, transcript } = req.body;

    if (!videoUrl || !query) {
        return res.status(400).json({ error: "Missing videoUrl or query" });
    }

    // Set headers for streaming
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");

    try {
        // Dynamically import youtube.js (ESM module)
        const youtubePath = path.resolve(__dirname, "youtube.js");
        const module = await import("file://" + youtubePath.replace(/\\/g, "/"));

        if (!module || !module.askYoutube) {
            throw new Error("askYoutube not found in youtube.js");
        }

        // Call askYoutube with context
        const context = { title, description, timestamp, transcript };
        const result = await module.askYoutube(videoUrl, query, context);

        // Handle result
        if (typeof result === "string") {
            // It's a direct message (e.g. no results found)
            res.write(JSON.stringify({ answer: result }));
            res.end();
        } else if (result && typeof result.stream === "function") {
            // It's a LangChain Runnable/Chain
            const stream = await result.stream({ query });

            for await (const chunk of stream) {
                // Send raw text chunks or JSON wrapped chunks
                // Client expects text or JSON. Let's send text chunks for simplicity as implemented in content.js
                res.write(chunk);
            }
            res.end();
        } else {
            throw new Error("Unexpected result from askYoutube");
        }

    } catch (err) {
        console.error("askYoutube error:", err);
        // If headers sent, we can't send status 500.
        if (!res.headersSent) {
            res.status(500).json({ error: err.message || "Server error" });
        } else {
            res.write(`\n\nError: ${err.message}`);
            res.end();
        }
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`askYoutube server running on http://localhost:${PORT}`);
});
