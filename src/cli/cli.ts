import { CODE_BASE_PATH } from '../config';
import agent from '../agent/workflow';
import { approveToolExecution, rejectToolExecution } from '../utils';
import { renderAgentUpdate, renderError, renderToolCall } from './toolRender';
import { renderToolApprovalPrompt, promptToolApproval } from './prompts';
import { HumanResponse } from '@langchain/langgraph/prebuilt';
import { AIMessage, BaseMessage, HumanMessage, ToolMessage, AIMessageChunk } from '@langchain/core/messages';
import { AgentType } from '../types';
import { color, ANSI, renderMarkdown } from './ui';
import { BinaryOperatorAggregate, Messages, UpdateType } from '@langchain/langgraph';

let hasStartedStreaming = false;


function renderMessagesChunk(messages: any): string {
    const outputs: string[] = [];

    if (Array.isArray(messages)) {
        for (const msg of messages) {
            if (msg instanceof AIMessageChunk){
                const content = msg.content;
                if (content && content.toString().trim()) {
                    const renderedContent = renderMarkdown(content.toString());
                    // const coloredText = color(renderedContent, ANSI.green);
                    const coloredText = renderedContent;
                    if (!hasStartedStreaming) {
                        // const icon = color("+ ", ANSI.green + ANSI.bold);
                        outputs.push(`${coloredText}`);
                        hasStartedStreaming = true;
                    } else {
                        outputs.push(coloredText);
                    }
                }
                // if (msg.tool_calls && msg.tool_calls.length > 0) {
                //     for (const toolCall of msg.tool_calls) {
                //         const toolCallsDisplay = renderToolCall(toolCall);
                //         if (toolCallsDisplay.trim()) {
                //             outputs.push(toolCallsDisplay);
                //         }
                //     }
                // }
            }
        }
    }

    return outputs.filter(output => output && output.trim()).join('');
}

function renderUpdatesChunk(updates: Record<string, UpdateType<{ messages: BinaryOperatorAggregate<BaseMessage[], Messages>; }>>): string {
    const outputs: string[] = [];
    for (const [node, values] of Object.entries(updates)) {
        const rendered = renderAgentUpdate(values);
        if (rendered) {
            outputs.push(rendered);
        }
    }
    return outputs.filter(output => output && output.trim()).join('\n\n');
}

export async function processUserInputStreaming(userInput: string, conversationId: string, agentType: AgentType): Promise<void> {
    const inputs = { messages: [new HumanMessage(userInput)] };

    hasStartedStreaming = false;

    let toSend = inputs;

    while (true) {
        try {
            const stream = await agent.stream(toSend, {
                configurable: { thread_id: conversationId, agent: agentType },
                streamMode: ["updates", "messages"] as const,
                recursionLimit: 50
            });

            for await (const [streamType, data] of stream) {
                if (streamType === 'messages') {
                    process.stdout.write(renderMessagesChunk(data));
                } else if (streamType === 'updates') {
                    console.log(`\n\n${renderUpdatesChunk(data)}`);
                }
                
            }

            const state = await agent.getState({
                configurable: { thread_id: conversationId, agent: agentType }
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

export { processUserInputStreaming as processUserInput };
