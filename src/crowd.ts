/**
 * Crowd class for simulating audience responses to jokes
 */
export class Crowd {
  private static responses = [
    "😂 Ha ha ha!",
    "🤣 That's hilarious!",
    "😄 Good one!",
    "👏 Nice!",
    "😆 LOL!",
    "🙄 Groan...",
    "😬 Awkward silence...",
    "👍 Not bad!",
    "🤔 I don't get it...",
    "😅 Ehh...",
  ];

  /**
   * Generates a random audience response to a joke
   * @param joke - The joke being told
   * @returns A string representing the crowd's reaction
   */
  static respond(joke: string): string {
    const randomIndex = Math.floor(Math.random() * this.responses.length);
    return this.responses[randomIndex];
  }
}
