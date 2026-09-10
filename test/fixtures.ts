/**
 * Envelopes captured verbatim from agy 1.2.0 on 2026-09-10.
 *
 * These are the contract this bridge parses. When an agy upgrade changes the
 * shape, these fixtures are what fails first — before a user's run does.
 */

/** `agy --output-format json -p "Reply with exactly: OK"` */
export const SUCCESS_ENVELOPE =
  '{"conversation_id":"2c324c36-e9e0-4c15-9202-2097d9d83d35","status":"SUCCESS",' +
  '"response":"OK\\n","duration_seconds":2.33446,"num_turns":1,' +
  '"usage":{"input_tokens":8108,"output_tokens":97,"thinking_tokens":96,' +
  '"cache_read_tokens":8133,"total_tokens":8205}}\n';

/**
 * `agy --mode plan --output-format json -p "Run the shell command 'echo hello'…"`
 *
 * The headline defect: exit 0, status SUCCESS, a plausible non-empty response —
 * and the command never ran. `response` is elided after the first sentence.
 */
export const DENIED_ENVELOPE =
  '{"conversation_id":"45b1e730-fb2b-4686-a257-6b6bba307cf2","status":"SUCCESS",' +
  '"response":"I have created the implementation plan in echo_command_plan.md.",' +
  '"duration_seconds":16.5,"num_turns":1,' +
  '"usage":{"input_tokens":8925,"output_tokens":812,"thinking_tokens":655,' +
  '"cache_read_tokens":8133,"total_tokens":9737},' +
  '"denied_actions":[{"action":"command","display_name":"RunCommand"}]}\n';

/**
 * `agy --output-format json --model "Bogus Model (High)" -p hi`, exit 1.
 * agy prints the human-readable error to stdout *before* the envelope, which is
 * why the parser scans backwards.
 */
export const ERROR_ENVELOPE =
  'error: invalid model selection (--model "Bogus Model (High)" --effort ""): model Bogus Model (High) is not recognized as a known model or custom model in settings\n' +
  "Available models:\n" +
  "  Gemini 3.8 Flash (High)\n" +
  "  Gemini 3.1 Pro (High)\n" +
  '{"conversation_id":"","status":"ERROR","response":"",' +
  '"error":"invalid model selection (--model \\"Bogus Model (High)\\" --effort \\"\\"): model Bogus Model (High) is not recognized as a known model or custom model in settings",' +
  '"duration_seconds":0,"num_turns":0,' +
  '"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,' +
  '"cache_read_tokens":0,"total_tokens":0}}\n';

/** `agy --output-format stream-json -p "Reply with exactly: OK"`, tools list elided. */
export const STREAM_NDJSON =
  '{"event":"init","conversation_id":"48b2bbd8-f9b2-404f-9883-d58c7b0e6d0f",' +
  '"init":{"cwd":"/tmp","tools":["run_command","view_file","search_web"],' +
  '"permission_mode":"request-review"}}\n' +
  '{"event":"step_update","step_update":{"conversation_id":"48b2bbd8-f9b2-404f-9883-d58c7b0e6d0f",' +
  '"step_index":0,"state":"DONE","step_type":"user_input"}}\n' +
  '{"event":"step_update","step_update":{"conversation_id":"48b2bbd8-f9b2-404f-9883-d58c7b0e6d0f",' +
  '"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}\n' +
  '{"event":"step_update","step_update":{"conversation_id":"48b2bbd8-f9b2-404f-9883-d58c7b0e6d0f",' +
  '"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\\n",' +
  '"duration_seconds":0.883129,"usage":{"input_tokens":8106,"output_tokens":24,' +
  '"thinking_tokens":23,"cache_read_tokens":8133,"total_tokens":8130}}}\n' +
  '{"event":"result","result":{"conversation_id":"48b2bbd8-f9b2-404f-9883-d58c7b0e6d0f",' +
  '"status":"SUCCESS","response":"OK\\n","duration_seconds":2.646249,"num_turns":1,' +
  '"usage":{"input_tokens":8106,"output_tokens":24,"thinking_tokens":23,' +
  '"cache_read_tokens":8133,"total_tokens":8130}}}\n';

/** A real 429 line as agy writes it to its --log-file. */
export const LOG_429 =
  "E0613 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): " +
  "Individual quota reached. Resets in 4h24m.";
