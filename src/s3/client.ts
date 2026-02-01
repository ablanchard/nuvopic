import {
  S3Client,
  GetObjectCommand,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";

let s3Client: S3Client | null = null;

export interface S3Config {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

function getS3Config(): S3Config {
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "S3_REGION, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables are required"
    );
  }

  return {
    endpoint: process.env.S3_ENDPOINT,
    region,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  };
}

export function getS3Client(): S3Client {
  if (!s3Client) {
    const config = getS3Config();

    s3Client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
    });
  }

  return s3Client;
}

export async function getObject(
  bucket: string,
  key: string
): Promise<GetObjectCommandOutput> {
  const client = getS3Client();
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return client.send(command);
}

export async function getObjectAsBuffer(
  bucket: string,
  key: string
): Promise<Buffer> {
  const response = await getObject(bucket, key);

  if (!response.Body) {
    throw new Error(`Empty response body for s3://${bucket}/${key}`);
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export function getS3Path(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}
