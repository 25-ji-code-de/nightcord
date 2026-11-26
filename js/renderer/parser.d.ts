export type SekaiToken = { type: 'text'; content: string } | {
  type: 'sekai'; version: number; sekaiType: string; payload: string; desc: Record<string, string>;
};
export class SekaiParser {
  constructor(options?: { maxTokensPerMessage?: number; maxPayloadBytes?: number });
  tokenize(text: string): SekaiToken[];
}
