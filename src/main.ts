/**
 * oyakata - Main entry point
 *
 * no
 */

import { greet } from "./lib";

function main(): void {
  const message = greet("World");
  console.log(message);
}

main();
