import { renderError } from "./cli/toolRender";
import { askQuestion, setupGracefulShutdown } from "./cli/prompts";
import { color, ANSI } from "./cli/ui";
import { MODEL } from "./config";
import { promptUserInput, closePrompts } from "./cli/prompts";
import { processUserInput } from "./cli/cli";
import { incrementalVectorStore } from "./lib/vector-store";
import { AgentType } from "./types";


async function main() {
    try {
        setupGracefulShutdown();
        // ask for which agent to use
        const agentType = await askQuestion("Which agent do you want to use? (coder, reviewer, planner, creator): ");
        
        if (!(agentType as AgentType)) {
            console.error("Invalid agent type");
            return;
        }
        console.log(`\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n`);
        
        const welcomeTitle = color("traycer ai", ANSI.cyan);
        const modelInfo = `${color("model:", ANSI.dim)} ${color(MODEL, ANSI.green)}`;
        const agentInfo = `${color("agent:", ANSI.dim)} ${color(agentType, ANSI.blue)}`;
        
        console.log(`\n${welcomeTitle}`);
        console.log(`${modelInfo}`);
        console.log(`${agentInfo}`);
        
        // await incrementalVectorStore.initialize();
        
        // let vectorStore = incrementalVectorStore.getVectorStore();
        
        // if (!vectorStore) {
        //     await incrementalVectorStore.rebuildIndex();
        // }
        
        // watching is not working 
        // incrementalVectorStore.startWatching();

        console.log("vector store ready\n");

        const conversationId = `session_${Date.now()}`;
        
        try {
            while (true) {
                const userInput = await promptUserInput();
                
                if (userInput.toLowerCase() === 'exit') {
                    console.log(color("bye!", ANSI.green));
                    break;
                }

                await processUserInput(userInput, conversationId, agentType as AgentType);
            }
        } catch (error) {
            console.error(renderError(error instanceof Error ? error : 'Unknown error'));
        } finally {
            // incrementalVectorStore.stopWatching();
            closePrompts();
        }
    } catch (error) {
        console.error("Error:", error);
    }
}

main().catch(console.error);
