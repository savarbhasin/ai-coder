import { renderError } from "./cli/toolRender";
import { setupGracefulShutdown } from "./cli/prompts";
import { color, ANSI } from "./cli/ui";
import { MODEL } from "./config";
import { promptUserInput, closePrompts } from "./cli/prompts";
import { processUserInput } from "./cli/cli";
import { incrementalVectorStore } from "./lib/vectorStore";


async function main() {
    try {
        setupGracefulShutdown();

        const welcomeTitle = color("traycer ai", ANSI.cyan);
        const modelInfo = `${color("model:", ANSI.dim)} ${color(MODEL, ANSI.green)}`;
        
        console.log(`\n${welcomeTitle}`);
        console.log(`${modelInfo}`);
        
        await incrementalVectorStore.initialize();
        
        let vectorStore = incrementalVectorStore.getVectorStore();
        if (!vectorStore) {
            await incrementalVectorStore.rebuildIndex();
        }
        
        incrementalVectorStore.startWatching();
        console.log("vector store ready\n");

        const conversationId = `session_${Date.now()}`;


        try {
            while (true) {
                const userInput = await promptUserInput();
                
                if (userInput.toLowerCase() === 'exit') {
                    console.log(color("bye!", ANSI.green));
                    break;
                }

                await processUserInput(userInput, conversationId);
            }
        } catch (error) {
            console.error(renderError(error instanceof Error ? error : 'Unknown error'));
        } finally {
            // Cleanup
            incrementalVectorStore.stopWatching();
            closePrompts();
        }
    } catch (error) {
        console.error("Error:", error);
    }
}

main().catch(console.error);
