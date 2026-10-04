import type { ModApi } from "../../sdk.d.ts";

export async function activate(api: ModApi): Promise<void> {
  await api.context.show();
}
