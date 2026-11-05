// `npm run sim` (SOT/simulation.md#server-npm-run-sim): the backend on a fresh simulated chain.
// Nothing here touches mainnet.
import { listen } from "./http.ts";
import { createSim } from "./world.ts";

const sim = await createSim({ mm: !process.argv.includes("--no-mm"), log: (message) => console.log(message) });
const { port } = await listen(sim, Number(process.env.PORT || 8787));
console.log(`simulated Setllend backend on http://localhost:${port} (a fresh chain, nothing reaches mainnet)`);
console.log(`maturities: ${sim.maturities.join(", ")}`);
console.log(`market-maker agent: ${sim.mmAccount ?? "off"}; keeper: ${sim.keeperAccount}`);
console.log(`fund an account: curl -X POST localhost:${port}/sim/faucet -H 'content-type: application/json' -d '{"account":"0x…","token":"USDC","amount":"1000000000"}'`);
