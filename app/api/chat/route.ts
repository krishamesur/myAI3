import {
  streamText,
  UIMessage,
  convertToModelMessages,
  stepCountIs,
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { MODEL } from "@/config";
import { SYSTEM_PROMPT } from "@/prompts";
import { isContentFlagged } from "@/lib/moderation";
import { webSearch } from "./tools/web-search";
import { vectorDatabaseSearch } from "./tools/search-vector-database";
import { fetchStockAnalysis } from "@/lib/stocks";

export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  // 1) Find the latest user message and its plain text
  const latestUserMessage = messages.filter((msg) => msg.role === "user").pop();

let textParts = "";
if (latestUserMessage) {
  textParts = latestUserMessage.parts
    .map((part: any) => part.text ?? "")
    .join("");
}
  // 2) Moderation check: if text breaks rules, stop and reply with a denial
  if (textParts) {
    const moderationResult = await isContentFlagged(textParts);

    if (moderationResult.flagged) {
      const stream = createUIMessageStream({
        execute({ writer }) {
          const textId = "moderation-denial-text";

          writer.write({
            type: "start",
          });

          writer.write({
            type: "text-start",
            id: textId,
          });

          writer.write({
            type: "text-delta",
            id: textId,
            delta:
              moderationResult.denialMessage ||
              "Your message violates our guidelines. I can't answer that.",
          });

          writer.write({
            type: "text-end",
            id: textId,
          });

          writer.write({
            type: "finish",
          });
        },
      });

      return createUIMessageStreamResponse({ stream });
    }
  }

  // 3) Treat the latest user text as the stock symbol (for Step 1)
  const symbol = textParts.trim();

  // 4) Call TwelveData through fetchStockAnalysis to get all metrics
  let stockAnalysisData: any = null;

  if (symbol) {
    try {
      stockAnalysisData = await fetchStockAnalysis(symbol);
      console.log("Stock analysis data from TwelveData:", stockAnalysisData);
    } catch (error) {
      console.error("Error fetching stock analysis", error);
    }
  }
console.log("Stock analysis data:", stockAnalysisData);
  // 5) Build a custom system prompt that includes the JSON from TwelveData
  let systemPrompt = SYSTEM_PROMPT;

  if (symbol) {
    if (stockAnalysisData) {
      systemPrompt +=
        "\n\nThe user asked about this stock symbol: " +
        symbol +
        ".\n" +
        "Here is structured stock data for this symbol from the TwelveData API, in JSON format. " +
        "Use this data to explain each metric in simple language for beginners:\n" +
        JSON.stringify(stockAnalysisData);
    } else {
      systemPrompt +=
        "\n\nThe user asked about stock symbol: " +
        symbol +
        ".\n" +
        "You could not fetch live metrics for this symbol. " +
        "Explain that live data is not available and politely ask the user to check the symbol format, " +
        "for example HDFCBANK.NSE or RELIANCE.NSE.";
    }
  }

  // 6) Call the model with the updated system prompt and the usual messages and tools
  const result = streamText({
    model: MODEL,
    system: systemPrompt,
    messages: convertToModelMessages(messages),
    tools: {
      webSearch,
      vectorDatabaseSearch,
    },
    stopWhen: stepCountIs(10),
    providerOptions: {
      openai: {
        reasoningSummary: "auto",
        reasoningEffort: "low",
        parallelToolCalls: false,
      },
    },
  });

  return result.toUIMessageStreamResponse({
    sendReasoning: true,
  });
}
