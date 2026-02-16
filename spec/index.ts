import { workerstack } from "@chr33s/workerstack";

export default {
  async fetch(request: Request) {
    return workerstack(request);
  },
};
