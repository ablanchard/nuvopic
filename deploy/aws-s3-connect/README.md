# NuvoPic Amazon S3 connector

`cloudformation.yaml` creates the customer-side read-only IAM role used by the
guided Amazon S3 setup. It does not create or modify the customer's bucket.

Before enabling the connector:

1. Upload `cloudformation.yaml` to a public, versioned S3 object controlled by
   the NuvoPic operator.
2. Set `AWS_CONNECT_TEMPLATE_URL` to that HTTPS S3 object URL.
3. Set `AWS_CONNECT_PRINCIPAL_ARN` to the NuvoPic IAM principal that assumes
   customer roles.
4. Give that principal permission to call `sts:AssumeRole` on roles named
   `NuvoPicRead-*` in customer accounts.
5. Supply credentials for the principal through the AWS default credential
   chain, or with `AWS_CONNECT_ACCESS_KEY_ID` and
   `AWS_CONNECT_SECRET_ACCESS_KEY`.

Customers never provide access keys. The app generates a unique external ID,
opens a pre-filled CloudFormation Quick Create page, derives the resulting role
ARN from the customer's account ID, and verifies bucket access with temporary
STS credentials.
