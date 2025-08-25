import { MessagesAnnotation, END, Command, interrupt} from "@langchain/langgraph";
import { HumanInterrupt, HumanResponse } from "@langchain/langgraph/prebuilt";
import { AIMessage, SystemMessage } from '@langchain/core/messages';
import { HUMAN_APPROVAL_TOOLS } from "../config";
import { getModel } from "./model";
import { ToolMessage } from "@langchain/core/messages";
import { coderTools, reviewerTools } from "./tools";
import { CODER_SYSTEM_PROMPT, REVIEWER_SYSTEM_PROMPT } from "./prompt";
import { RunnableConfig } from "@langchain/core/runnables";
import { DynamicStructuredTool } from "@langchain/core/tools";

type RouteDestination = typeof END | "human_review_node" | "run_tool";


export const humanReviewNode = async (state: typeof MessagesAnnotation.State): Promise<Command> => {
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
    const toolCall = lastMessage.tool_calls![lastMessage.tool_calls!.length - 1];
    
    if (!toolCall) {
        throw new Error("Tool call is undefined");
    }

    const humanReview = interrupt<HumanInterrupt, HumanResponse>({
        action_request: {
            action: `execute ${toolCall.name} tool`,
            args: toolCall.args || {}
        },
        config: {
            allow_accept: true,
            allow_ignore: false,
            allow_respond: true,
            allow_edit: false
        },
        description: `Do you want to execute this ${toolCall.name} operation?`
    });

    if (humanReview.type === "accept") {
        return new Command(
            { 
                goto: "run_tool" 
            }
        );
    } else if (humanReview.type === "response") { 
        return new Command(
            { 
                resume: {
                    action: "feedback",
                    data: humanReview.args as string
                }
            }
        );
    } else {
        return new Command(
            { 
                goto: END
            }
        );
    }
        
};

export const routeAfterLLM = (state: typeof MessagesAnnotation.State): RouteDestination => {
    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
    
    // if no tool calls, end the workflow
    if (!lastMessage.tool_calls?.length) {
        return END;
    }

    const requiresApproval = lastMessage.tool_calls.some(toolCall => 
        HUMAN_APPROVAL_TOOLS.includes(toolCall.name)
    );

    if (requiresApproval) {
        return "human_review_node";
    }

    return "run_tool";
};


export const runTool = async (
    state: typeof MessagesAnnotation.State, 
    config: RunnableConfig
) => {
    const newMessages: ToolMessage[] = [];
    
    let toolsMap: Record<string, DynamicStructuredTool>;
    if (config.configurable?.agent === "coder") {
        toolsMap = Object.fromEntries(coderTools.map(tool => [tool.name, tool as DynamicStructuredTool]));
    } else if (config.configurable?.agent === "reviewer") {
        toolsMap = Object.fromEntries(reviewerTools.map(tool => [tool.name, tool as DynamicStructuredTool]));
    } else {
        throw new Error("Invalid agent");
    }

    const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
    const toolCalls = lastMessage.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
        return { messages: [] };
    }

    for (const toolCall of toolCalls) {
        if (!toolCall || !toolCall.name || !toolCall.id) {
            continue;
        }
        
        const tool = toolsMap[toolCall.name];

        if (!tool) {
            newMessages.push(new ToolMessage({
                name: toolCall.name,
                content: `Error: Tool ${toolCall.name} not found`,
                tool_call_id: toolCall.id
            }));
            continue;
        }

        try {
            const result = await tool.invoke(toolCall.args);
            newMessages.push(new ToolMessage({
                name: toolCall.name,
                content: result,
                tool_call_id: toolCall.id
            }));
        } catch (error) {
            newMessages.push(new ToolMessage({
                name: toolCall.name,
                content: `Error executing tool: ${error instanceof Error ? error.message : 'Unknown error'}`,
                tool_call_id: toolCall.id
            }));
        }
    }
    return { messages: newMessages };
};


export const callLLM = async (
    state: typeof MessagesAnnotation.State,
    config: RunnableConfig,
) => {
    const agentType = config.configurable?.agent;
    
    if (!agentType) {
        throw new Error("agent type is required");
    }

    const systemPrompt = agentType === 'coder' ? CODER_SYSTEM_PROMPT : REVIEWER_SYSTEM_PROMPT;
    
    const messages = [
        new SystemMessage(systemPrompt),
        ...state.messages
    ];
    
    const tools = agentType === 'coder' ? coderTools : reviewerTools;
    const model = getModel().bindTools(tools);
    const response = await model.invoke(messages);
    return { messages: [response] };
};

