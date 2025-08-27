export const VECTOR_STORE_PATH = "./faiss_index";
export const CODE_BASE_PATH = ".";
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const MAX_CHARS = 4000;
export const K = 5;
export const MODEL = process.env.MODEL || "gemini-2.5-pro" ;
export const HUMAN_APPROVAL_TOOLS = ["diff_edit_file", "run_terminal_cmd"];
export const SIMILARITY_SCORE_THRESHOLD = 0.7;