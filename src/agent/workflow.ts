import { MessagesAnnotation, StateGraph, START, END, MemorySaver} from "@langchain/langgraph";
import { humanReviewNode, routeAfterLLM, callLLM, runTool } from "./agent";


const graph = new StateGraph(MessagesAnnotation)
    .addNode("call_llm", callLLM)
    .addNode("run_tool", runTool)
    .addNode("human_review_node", humanReviewNode, {
        ends: ["run_tool", "call_llm"]
    })
    .addEdge(START, "call_llm")
    .addConditionalEdges(
        "call_llm",
        routeAfterLLM,
        ["human_review_node", "run_tool", END]
    )
    .addEdge("run_tool", "call_llm");

const checkpointer = new MemorySaver();
const workflow =graph.compile({
    checkpointer
});

export default workflow;