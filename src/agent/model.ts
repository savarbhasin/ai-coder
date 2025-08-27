import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { MODEL } from "../config";

export function getModel() {
    if (MODEL === "openai") {
        return new ChatOpenAI({
            model: "o4-mini",
            apiKey: process.env.OPENAI_API_KEY!
        })
    } else {
        return new ChatGoogleGenerativeAI({
            model: "gemini-2.5-flash",
            temperature: 0.2,
            apiKey: process.env.GEMINI_API_KEY!
        })
    }
}




