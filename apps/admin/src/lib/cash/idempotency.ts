/**
 * Idempotency-Key of the cash-payment form (POST /admin/cash-payments). One key per payment being
 * recorded: a new random UUID (crypto.randomUUID) for each new submission, the same key when the
 * very same request is sent again after a failure without an answer (network error, timeout,
 * 5xx), so a retry can never record the payment twice. Any change to the form's values, or a
 * success, starts a new key: the API would refuse a reused key with different values
 * (IDEMPOTENCY_KEY_REUSED).
 */
export class IdempotencyKeys {
  private current: { fingerprint: string; key: string } | null = null;

  constructor(private readonly newKey: () => string = () => crypto.randomUUID()) {}

  /** The key for a request; `fingerprint` identifies its content. */
  keyFor(fingerprint: string): string {
    if (this.current?.fingerprint !== fingerprint) {
      this.current = { fingerprint, key: this.newKey() };
    }
    return this.current.key;
  }

  /** After a definite answer (success or a 4xx): the next submission gets a new key. */
  settle(): void {
    this.current = null;
  }
}
