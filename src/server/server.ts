import express from 'express';
import cors from 'cors';
import { Request, Response } from 'express';
import agent from '../agent/workflow';
import { approveToolExecution, rejectToolExecution } from '../utils';
import { AgentType } from '../types';
import { AIMessage, BaseMessage, HumanMessage, ToolMessage, AIMessageChunk } from '@langchain/core/messages';
import { BinaryOperatorAggregate, Messages, UpdateType } from '@langchain/langgraph';
import { incrementalVectorStore } from '../lib/vector-store';


const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// SSE endpoint for agent streaming
app.get('/api/stream/:conversationId/:agentType', async (req: Request, res: Response) => {
    const { conversationId, agentType } = req.params;
    const { message } = req.query;

    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'Message is required as query parameter' });
    }
    console.log('agentType', agentType);
    console.log('conversationId', conversationId);
    // Validate agent type
    const validAgentTypes: AgentType[] = ['reviewer', 'planner', 'creator'];
    if (!validAgentTypes.includes(agentType as AgentType)) {
        return res.status(400).json({ error: 'Invalid agent type' });
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected', conversationId, agentType })}\n\n`);

    const inputs = { messages: [new HumanMessage(message)] };
    let toSend = inputs;

    try {
        while (true) {
            const stream = await agent.stream(toSend, {
                configurable: { thread_id: conversationId, agent: agentType as AgentType },
                streamMode: ["updates", "messages"] as const,
                recursionLimit: 50
            });

            for await (const [streamType, data] of stream) {
                if (streamType === 'messages') {
                    await processMessageChunks(data, res);
                } else if (streamType === 'updates') {
                    await processUpdates(data, res);
                }
            }

            break;
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error during processing';
        res.write(`data: ${JSON.stringify({
            type: 'error',
            message: errorMessage
        })}\n\n`);
    }

    // End the stream
    res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
    res.end();
});


async function processMessageChunks(messages: any, res: Response) {
    if (Array.isArray(messages)) {
        for (const msg of messages) {
            if (msg instanceof AIMessageChunk) {
                const content = msg.content;
                if (content && content.toString().trim()) {
                    res.write(`data: ${JSON.stringify({
                        type: 'message_chunk',
                        content: content.toString()
                    })}\n\n`);
                }

                // Handle tool calls in chunks
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    for (const toolCall of msg.tool_calls) {
                        if (toolCall.name.trim()) {
                            res.write(`data: ${JSON.stringify({
                                type: 'tool_call',
                                toolCall: {
                                    id: toolCall.id,
                                    name: toolCall.name,
                                    args: toolCall.args
                                },
                                display: toolCall.name
                            })}\n\n`);
                        }
                    }
                }
            }
        }
    }
}

async function processUpdates(updates: Record<string, UpdateType<{ messages: BinaryOperatorAggregate<BaseMessage[], Messages>; }>>, res: Response) {
    for (const [node, values] of Object.entries(updates)) {
        const messages = values?.messages ?? [];

        if (!Array.isArray(messages) || messages.length === 0) {
            continue;
        }

        for (const msg of messages) {
            const message = msg as BaseMessage;

            if (message.getType() === 'tool') {
                const toolMessage = message as ToolMessage;
                const toolName = toolMessage?.name || 'unknown';
                const rawContent = typeof toolMessage?.content === 'string' ? toolMessage.content : JSON.stringify(toolMessage?.content);

                res.write(`data: ${JSON.stringify({
                    type: 'tool_output',
                    toolName,
                    content: rawContent
                })}\n\n`);
            } else if (message.getType() === 'ai') {
                const aiMessage = message as AIMessage;

                // Handle final AI message content (non-streaming)
                const content = Array.isArray(aiMessage.content)
                    ? aiMessage.content.map(c => {
                        if (typeof c === 'string') return c;
                    }).join('\n')
                    : aiMessage.content;

                // if (content && content.trim()) {
                //     res.write(`data: ${JSON.stringify({
                //         type: 'message_complete',
                //         content: content.toString()
                //     })}\n\n`);
                // }
            }
        }
    }
}

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize vector store on server startup
async function startServer() {
    try {
        console.log('Initializing vector store...');
        await incrementalVectorStore.initialize();
        console.log('Vector store initialized successfully');

        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Failed to initialize vector store:', error);
        process.exit(1);
    }
}

startServer();
