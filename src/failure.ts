export function failureText(error: unknown): string {
  return `${(error as { message: unknown }).message}`;
}
