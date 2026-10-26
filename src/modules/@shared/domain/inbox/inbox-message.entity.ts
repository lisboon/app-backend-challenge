export interface InboxDelivery {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface ReceiveInboxProps extends InboxDelivery {
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
}

export class InboxMessage {
  private constructor(
    readonly consumerName: string,
    readonly messageId: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      props.consumerName,
      props.messageId,
      props.payloadHash,
      props.receivedAt,
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.consumerName,
      state.messageId,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new Error('mensagem da inbox já processada');
    }
    if (at < this.receivedAt) {
      throw new Error('processamento anterior ao recebimento');
    }
    this._processedAt = at;
  }
}
