// Data access for every component (SOT/frontend.md#data, D65, D74): the mocks in Demo; in Live, the
// backend API once its contract is `ready`, the mocks until then. Every call waits for the first mode
// (at once in Demo, after the first `/health` answer in Live), so nothing is read from the wrong source
// first; the mode provider clears the cache when the mode changes.

import * as http from "./http";
import * as mock from "./mock";
import { currentMode, modeKnown } from "./mode";

type Api = typeof mock;
const source = (): Api => (currentMode() === "live" ? http : mock);

const call =
  <K extends Exclude<keyof Api, "subscribe">>(name: K) =>
  async (...args: Parameters<Api[K]>): Promise<Awaited<ReturnType<Api[K]>>> => {
    await modeKnown();
    return (source()[name] as (...a: Parameters<Api[K]>) => Promise<Awaited<ReturnType<Api[K]>>>)(...args);
  };

export const getConfig = call("getConfig");
export const getMaturities = call("getMaturities");
export const getMaturityStats = call("getMaturityStats");
export const getBook = call("getBook");
export const getPrices = call("getPrices");
export const getCollateralTokens = call("getCollateralTokens");
export const getStats = call("getStats");
export const getAccount = call("getAccount");
export const getAccountFills = call("getAccountFills");
export const getAccountHistory = call("getAccountHistory");
export const getTrades = call("getTrades");

/** Live pushes from the source of the current mode; subscribers re-subscribe when the mode changes. */
export const subscribe: Api["subscribe"] = (channels, onMessage) => source().subscribe(channels, onMessage);

export { DEMO_WALLET } from "./demo-wallet";
export { API_URL, type ApiMode } from "./mode";
export type * from "./types";
