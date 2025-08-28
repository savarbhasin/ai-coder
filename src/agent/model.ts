import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import dotenv from "dotenv";

dotenv.config();

export function getModel() {
    const MODEL = process.env.MODEL || "gemini";
    if (MODEL === "openai") {
        const reasoning = {
            effort: "medium" as const, // 'low', 'medium', or 'high'
            summary: "auto" as const, // 'detailed', 'auto', or null
        };

        return new ChatOpenAI({
            model: process.env.OPENAI_MODEL || "gpt-4.1",
            apiKey: process.env.OPENAI_API_KEY!,
            // temperature: 0.2,
            // reasoning: reasoning,
            // useResponsesApi: true
        })
    } else {
        return new ChatGoogleGenerativeAI({
            model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
            temperature: 0.2,
            apiKey: process.env.GEMINI_API_KEY!,
        })
    }
}




