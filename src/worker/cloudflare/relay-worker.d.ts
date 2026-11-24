// Types for relay-worker.js, which stays plain JavaScript because it is uploaded as it is.
export interface RelayEnv {
  OPENINBOX_URL: string;
  ACCOUNT_ID: string;
  RELAY_SECRET: string;
}

declare const relay: {
  email(message: ForwardableEmailMessage, env: RelayEnv): Promise<void>;
};
export default relay;
