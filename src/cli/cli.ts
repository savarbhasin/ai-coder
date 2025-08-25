import { CODE_BASE_PATH } from '../config';
import agent from '../agent/workflow';
import { approveToolExecution, rejectToolExecution } from '../utils';
import { renderAgentUpdate, renderError } from './toolRender';
import { renderToolApprovalPrompt, promptToolApproval } from './prompts';
import { HumanResponse } from '@langchain/langgraph/prebuilt';
import { AIMessage, HumanMessage } from '@langchain/core/messages';


export async function processUserInput(userInput: string, conversationId: string): Promise<void> {
    const inputs = { messages: [new HumanMessage(userInput)] };

    let toSend = inputs;

    
    while (true) {
        try {
            const stream = await agent.stream(toSend, { 
                configurable: { thread_id: conversationId, agent: "coder" }, 
                streamMode: "updates"
            });

            //process streaming updates
            for await (const chunk of stream) {
                for (const [node, values] of Object.entries(chunk)) {
                    const rendered = renderAgentUpdate(values);
                    console.log(rendered);
                }
            }

            // check if human review is needed
            const state = await agent.getState({
                configurable: { thread_id: conversationId }
            });

            if (state.next && state.next.includes('human_review_node')) {
                const lastMessage = state.values.messages[state.values.messages.length - 1];
                const toolCall = (lastMessage as AIMessage)?.tool_calls?.[0];

                if (toolCall) {
                    await renderToolApprovalPrompt(toolCall, CODE_BASE_PATH);
                    const response = await promptToolApproval(toolCall);
                    toSend = await processApprovalResponse(response);
                    continue;
                }
            }
            

            break;

        } catch (error) {
            console.error(renderError(error instanceof Error ? error : 'Unknown error during processing'));
            break;
        }
    }
}

async function processApprovalResponse(response: HumanResponse): Promise<any> {
    if (response.type === "accept") {
        return approveToolExecution();
    } else if (response.type === "response") {
        return rejectToolExecution(response.args as string || "User rejected the action");
    } else {
        return rejectToolExecution("User rejected the action");
    }
}



