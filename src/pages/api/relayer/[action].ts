import type { APIRoute } from "astro";
import { handleRelayerRequest } from "../../../lib/tokenization-relayer";

export const prerender = false;

function toResponse(result: Awaited<ReturnType<typeof handleRelayerRequest>>) {
  return new Response(JSON.stringify(result.body), {
    status: result.status ?? 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export const GET: APIRoute = async ({ params, request }) => {
  const action = params.action ?? "";
  return toResponse(await handleRelayerRequest(action, request));
};

export const POST: APIRoute = async ({ params, request }) => {
  const action = params.action ?? "";
  return toResponse(await handleRelayerRequest(action, request));
};
