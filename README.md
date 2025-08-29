## agents
1. **creator**
   - creates different phases by exploring the codebase
2. **planner**
   - implements the phases one by one
3. **reviewer**
   - not only file reviewer but also implementations
4. **coder** (NEW)
   - a cli coding assistant like gemini-cli

# more about it
- the agents have access to a bunch of tools like `search_codebase`, `grep`, `read_file`, `write_file`, `diff_edit_file`, `global_file_search`, `list_dir`, `run_terminal_cmd`
- they use this to gather context and perform the best actions
- on cli startup all the files are indexed into the vector db. 
- this creates embeddings for all .ts code, chunks it intelligently with tree-sitter for better search quality, and stores everything in Pinecone. 
- making search_codebase blazing fast for finding similar code patterns across your entire codebase.
- additionally, human in the loop for running terminal commands and applying diffs.


## features
- uses langgraph for agent orchestration
- setup langsmith for observability
- in memory conversation saver

## demo
- cli based access to the project
- for demo purposes, a quick frontend was vibecoded — you can check out the demo video here: [link]()  



## how to run
- `npm install --legacy-peer-deps`
- `npm run dev`
