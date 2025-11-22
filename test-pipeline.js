// test-pipeline.js
import fetch from "node-fetch";

const SERVER_URL = "http://localhost:3000/ask-youtube";

const MOCK_REQUEST = {
    videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", // Rick Roll (classic test)
    query: "What is this video about?",
    title: "Rick Astley - Never Gonna Give You Up",
    description: "The official video for Never Gonna Give You Up by Rick Astley",
    timestamp: 10,
    // Optional: Provide a mock transcript to avoid actual YouTube fetching if desired
    transcript: "We're no strangers to love. You know the rules and so do I. A full commitment's what I'm thinking of. You wouldn't get this from any other guy. I just wanna tell you how I'm feeling. Gotta make you understand. Never gonna give you up. Never gonna let you down. Never gonna run around and desert you. Never gonna make you cry. Never gonna say goodbye. Never gonna tell a lie and hurt you."
};

async function testPipeline() {
    console.log("Starting Pipeline Test...");
    console.log(`Target: ${SERVER_URL}`);

    try {
        const response = await fetch(SERVER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(MOCK_REQUEST)
        });

        if (!response.ok) {
            throw new Error(`Server returned ${response.status}: ${response.statusText}`);
        }

        console.log("Response received. Reading stream...");

        // Handle streaming response
        // In Node.js fetch, body is a stream
        for await (const chunk of response.body) {
            const text = chunk.toString();
            process.stdout.write(text);
        }

        console.log("\n\nTest Completed Successfully!");

    } catch (error) {
        console.error("\nTest Failed:", error.message);
        if (error.code === 'ECONNREFUSED') {
            console.log("Hint: Is the server running? (node server.js)");
        }
    }
}

testPipeline();
