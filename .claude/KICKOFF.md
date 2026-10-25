# How to run the agents in parallel

Paste one wave at a time into the main `claude` session. Wait for each wave's reports (and the reviewer's GO) before the next.

## Wave 1 — parallel
> Run these subagents in parallel: **infra** (monorepo skeleton, docker-compose, CDK stacks, CI) and **face-poc** (evaluation harness + FaceProvider implementations). They touch different folders. Collect both final reports and summarize open risks.

## Wave 2 — sequential (do not parallelize)
> Use the **contracts** subagent to build packages/shared and packages/db for the whole data model and API surface. Then run **reviewer** on it.

## Wave 3 — Phase 2 Drive, parallel
> Phase 2 (Drive). Run in parallel: **api** (drive + upload modules), **worker** (media consumer, trash purge, quota reconciliation), **web** (/studio drive UI with Uppy). Each must stay in its own folder. Collect CONTRACT CHANGE REQUESTs and send them to **contracts** afterwards, then run **reviewer**.

## Wave 4 — Phase 3 Sharing + face search, parallel
> Phase 3. Run in parallel: **api** (share, face, download modules), **worker** (faces + zip consumers), **web** (/s/[token] share page, consent, scan, downloads). Then **reviewer**.

## Wave 5 — Phase 4 Billing, parallel
> Phase 4. **api** (billing, webhooks, subscription lifecycle) + **worker** (daily transitions, reminders) + **web** (plans, checkout). Then **reviewer**.

## Wave 6 — Phase 5 Admin, parallel
> Phase 5. **api** (admin + analytics modules) + **worker** (hourly rollup) + **admin** (dashboard app). Then **reviewer**.

## Tips
- If agents step on each other, tell the main session: "run each subagent in its own git worktree" (or open separate terminals with `git worktree add`), then merge after review.
- Commit after every wave so you can roll back one wave cleanly.
- Run `/agents` once to confirm all 8 agents are detected.
