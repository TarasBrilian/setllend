// NEAR JSON-RPC from the browser: balances (D51) and the key check before signed intents (D66).

/** Same public RPC as the backend's default `NEAR_RPC_URL` (SOT/backend.md#configuration). */
const NEAR_RPC = "https://free.rpc.fastnear.com";

export async function nearRpc<T>(method: string, params: object): Promise<T> {
  const response = await fetch(NEAR_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "setllend", method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message ?? "NEAR RPC error");
  return body.result;
}

/** A view call at the latest final block, its JSON result parsed. */
export async function nearView<T>(contractId: string, method: string, args: object): Promise<T> {
  const result = await nearRpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result))) as T;
}
