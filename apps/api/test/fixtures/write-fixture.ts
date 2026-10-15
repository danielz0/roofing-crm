// Writes the synthetic snapshot to a temp dir and prints its path (used for manual packaging checks).
import { createSyntheticSnapshot } from "./synthetic-snapshot.js";
console.log(await createSyntheticSnapshot());
