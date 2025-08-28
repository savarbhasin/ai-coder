import { MessagesAnnotation, END, Command, interrupt} from "@langchain/langgraph";
import { HumanInterrupt, HumanResponse } from "@langchain/langgraph/prebuilt";
import { AIMessage, SystemMessage } from '@langchain/core/messages';
import { HUMAN_APPROVAL_TOOLS } from "../config";
import { getModel } from "./model";
import { ToolMessage } from "@langchain/core/messages";
import { coderTools, reviewerTools } from "./tools";
import { RunnableConfig } from "@langchain/core/runnables";
import { DynamicStructuredTool, Tool } from "@langchain/core/tools";
import { CODER_SYSTEM_PROMPT } from "./prompts/coder";
import { REVIEWER_SYSTEM_PROMPT } from "./prompts/reviewer";
import { PLANNER_AGENT_PROMPT } from "./prompts/planner";
import { CREATE_PHASE_PROMPT } from "./prompts/creator";

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
    } else {
        toolsMap = Object.fromEntries(reviewerTools.map(tool => [tool.name, tool as DynamicStructuredTool]));
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

    // TODO: after a turn ends, need to remove tool call results
    
    
    let systemPrompt: string;
    if (agentType === "coder") {
        systemPrompt = CODER_SYSTEM_PROMPT;
    } else if (agentType === "reviewer") {
        systemPrompt = REVIEWER_SYSTEM_PROMPT;
    } else if (agentType === "planner") {
        systemPrompt = PLANNER_AGENT_PROMPT;
    } else if (agentType === "creator") {
        systemPrompt = CREATE_PHASE_PROMPT;
    } else {
        throw new Error("Invalid agent type");
    }
    
    const messages = [
        new SystemMessage(systemPrompt),
        ...state.messages
    ];
    
    const tools = agentType === 'coder' ? coderTools : reviewerTools;
    const model = getModel().bindTools(tools);
    const response = await model.invoke(messages);
    return { messages: [response] };
};

