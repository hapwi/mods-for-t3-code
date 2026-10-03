export async function activate(api) {
  await api.commands.register({ id: "review", title: "Draft a focused code review" }, () => api.draft.insert("Review the changes in this thread. Focus on correctness and the behavior requested. Explain any concrete issues and the smallest fix."));
  await api.commands.register({ id: "debug", title: "Draft a debugging request" }, () => api.draft.insert("Investigate this failure. Find the smallest reproducible cause, explain it, and make a focused fix. Run only the checks needed to confirm the fix."));
}
