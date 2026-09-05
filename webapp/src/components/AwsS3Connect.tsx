import { useEffect, useState } from 'preact/hooks';
import { api, type AwsConnectionStatus } from '../api/client';

const EMPTY_STATUS: AwsConnectionStatus = {
  state: 'not_started',
  available: true,
  bucket: null,
  region: null,
  accountId: null,
  roleName: null,
  roleArn: null,
  launchUrl: null,
};

interface AwsS3ConnectProps {
  onConnected?: () => void | Promise<void>;
}

export function AwsS3Connect(props: AwsS3ConnectProps) {
  const [connection, setConnection] = useState<AwsConnectionStatus>(EMPTY_STATUS);
  const [bucket, setBucket] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [accountId, setAccountId] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const normalizedBucket = bucket.trim().replace(/^s3:\/\//i, '').split('/', 1)[0].toLowerCase();
  const hasPendingChanges = connection.state === 'pending' && (
    normalizedBucket !== connection.bucket ||
    region.trim().toLowerCase() !== connection.region ||
    accountId.trim() !== connection.accountId
  );

  useEffect(() => {
    api.settings.getAwsConnection()
      .then((status) => {
        setConnection(status);
        setBucket(status.bucket ?? '');
        setRegion(status.region ?? 'us-east-1');
        setAccountId(status.accountId ?? '');
      })
      .catch((error) => {
        setMessage({
          type: 'error',
          text: error instanceof Error ? error.message : 'Unable to load AWS setup',
        });
      })
      .finally(() => setLoading(false));
  }, []);

  const beginConnection = async () => {
    setWorking(true);
    setMessage(null);
    try {
      const status = await api.settings.beginAwsConnection({ bucket, region, accountId });
      setConnection(status);
      setBucket(status.bucket ?? bucket);
      setRegion(status.region ?? region);
      setAccountId(status.accountId ?? accountId);
      setMessage({
        type: 'success',
        text: 'AWS setup is ready. Open CloudFormation to create the read-only connection.',
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to prepare AWS setup',
      });
    } finally {
      setWorking(false);
    }
  };

  const verifyConnection = async () => {
    setWorking(true);
    setMessage(null);
    try {
      const status = await api.settings.verifyAwsConnection();
      setConnection(status);
      setMessage({ type: 'success', text: 'Amazon S3 connected successfully.' });
      await props.onConnected?.();
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to verify the AWS connection',
      });
    } finally {
      setWorking(false);
    }
  };

  if (loading) {
    return <div class="settings-card"><div class="loading">Loading AWS setup…</div></div>;
  }

  if (connection.state === 'connected') {
    return (
      <div class="settings-card aws-connect-card">
        <div class="aws-connect-success" role="status">
          <span aria-hidden="true">✓</span>
          <div>
            <strong>Amazon S3 connected</strong>
            <p>NuvoPic uses temporary credentials to read <code>s3://${connection.bucket}</code>.</p>
          </div>
        </div>
        <button
          class="btn btn-secondary aws-reconnect"
          type="button"
          onClick={() => setConnection({ ...connection, state: 'not_started', launchUrl: null })}
        >
          Change AWS bucket
        </button>
        {message && <div class={`settings-status settings-status--${message.type}`}>{message.text}</div>}
      </div>
    );
  }

  return (
    <div class="settings-card aws-connect-card">
      <div class="aws-connect-heading">
        <div class="aws-connect-mark" aria-hidden="true">AWS</div>
        <div>
          <strong>Connect Amazon S3 securely</strong>
          <p>CloudFormation creates a bucket-scoped, read-only role. NuvoPic never receives your AWS access keys.</p>
        </div>
      </div>

      <div class="aws-connect-fields">
        <div class="field">
          <label class="setting-label" htmlFor="aws-bucket">Bucket name or S3 URL</label>
          <input
            class="setting-text-input"
            id="aws-bucket"
            type="text"
            value={bucket}
            placeholder="s3://my-photos"
            onInput={(event) => setBucket((event.target as HTMLInputElement).value)}
            disabled={working}
          />
        </div>
        <div class="aws-connect-field-grid">
          <div class="field">
            <label class="setting-label" htmlFor="aws-region">AWS region</label>
            <input
              class="setting-text-input"
              id="aws-region"
              type="text"
              value={region}
              placeholder="us-east-1"
              onInput={(event) => setRegion((event.target as HTMLInputElement).value)}
              disabled={working}
            />
          </div>
          <div class="field">
            <label class="setting-label" htmlFor="aws-account-id">AWS account ID</label>
            <input
              class="setting-text-input"
              id="aws-account-id"
              type="text"
              inputMode="numeric"
              maxLength={12}
              value={accountId}
              placeholder="123456789012"
              onInput={(event) => setAccountId((event.target as HTMLInputElement).value)}
              disabled={working}
            />
          </div>
        </div>
      </div>

      {connection.state === 'not_started' ? (
        <button class="btn btn-primary" type="button" onClick={beginConnection} disabled={working || !connection.available}>
          {working ? 'Preparing…' : 'Prepare AWS setup'}
        </button>
      ) : (
        <div class="aws-connect-steps">
          {hasPendingChanges && (
            <button class="btn btn-secondary" type="button" onClick={beginConnection} disabled={working}>
              {working ? 'Updating…' : 'Update AWS setup'}
            </button>
          )}
          <div class="aws-connect-step">
            <span>1</span>
            <div>
              <strong>Create the AWS stack</strong>
              <p>Review the read-only policy and choose <strong>Create stack</strong> in AWS.</p>
            </div>
          </div>
          {connection.launchUrl && (
            <a class="btn btn-primary aws-launch" href={connection.launchUrl} target="_blank" rel="noreferrer">
              Open AWS CloudFormation ↗
            </a>
          )}
          <div class="aws-connect-step">
            <span>2</span>
            <div>
              <strong>Verify the connection</strong>
              <p>After the AWS stack reaches <code>CREATE_COMPLETE</code>, return here and continue.</p>
            </div>
          </div>
          <button class="btn btn-primary" type="button" onClick={verifyConnection} disabled={working}>
            {working ? 'Verifying…' : 'I created the stack — verify'}
          </button>
        </div>
      )}

      {!connection.available && (
        <div class="settings-status settings-status--error">
          Amazon S3 guided setup is not configured on this NuvoPic server.
        </div>
      )}
      {message && <div class={`settings-status settings-status--${message.type}`}>{message.text}</div>}
    </div>
  );
}
