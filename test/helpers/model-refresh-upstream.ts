/** Controlled provider edge: production serializers/parsers still run. */
export function modelRefreshCompletion(model: string): Response {
  if (model.startsWith("spacexai/")) {
    const chunk = {
      id: "chat_refresh",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "qualification done" },
          finish_reason: null,
        },
      ],
    };
    const done = {
      ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    };
    return new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  const output = {
    id: "msg_refresh",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "qualification done", annotations: [] }],
  };
  const events = model.startsWith("openai/")
    ? [
        { type: "response.created", response: { id: "resp_refresh", status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { ...output, content: [] } },
        {
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          item_id: output.id,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: output.id,
          delta: "qualification done",
        },
        { type: "response.output_item.done", output_index: 0, item: output },
        {
          type: "response.completed",
          response: {
            id: "resp_refresh",
            status: "completed",
            output: [output],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          },
        },
      ]
    : [
        {
          type: "message_start",
          message: {
            id: "msg_refresh",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "qualification done" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        { type: "message_stop" },
      ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
