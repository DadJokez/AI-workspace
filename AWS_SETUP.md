# AWS setup — first time

You need this once, on your laptop, before flipping the chat over to real Bedrock. Total time: 30–60 min if you've never used AWS.

After step 7, your local `pnpm dev` with `BEDROCK_CLIENT=real` will call AWS Claude. None of this deploys anything yet — that's PR #8 (Terraform).

**Open the [AWS Console](https://aws.amazon.com/console/) in a tab** and keep it open while you work. Most of the confusion goes away when you can see what your CLI is doing in the web UI.

---

## 1. Create the AWS account

If you don't have one, sign up at <https://aws.amazon.com/>. Use a personal email (not your work one) for the **root user** if this is your funded-by-you experiment account. Add a credit card. Pick a name like `comparative-personal`.

The root user is the one who created the account. **Don't use it day-to-day.** You'll create a separate IAM user in step 4.

## 2. Set a budget alert (do this *before* anything else)

Console → search "Budgets" → **Create budget** → "Use a template" → **Zero spend budget** → set the email alert to your inbox → save.

This emails you the moment your monthly bill goes from $0 to $0.01. It's the cheapest insurance against a misconfigured Bedrock loop.

(Later, when you actually expect spend, replace it with a normal cost budget at $10 / $50 / $100 thresholds. PLAN.md calls those out.)

## 3. Pick a region

Use **`us-east-1`** (N. Virginia). It has every Claude model and is the AWS default. The region selector is the dropdown next to your username in the console — set it now.

You can use other regions later, but mixing regions for one stack adds confusion. Stay in one for the MVP.

## 4. Create an IAM user for local CLI use

Console → **IAM** → Users → **Create user**

- Name: `local-dev`
- **Do not** check "Provide user access to the AWS Management Console" (this user is for the CLI only)
- Permissions: **Attach policies directly** → search and check `AmazonBedrockFullAccess`
- Create user

Now create the access key:

- Open the new user → **Security credentials** tab → **Create access key**
- Use case: **Command Line Interface (CLI)** → confirm
- (Skip the description) → **Create access key**
- **Download the .csv** — this is the only time AWS will show you the secret. Save it somewhere safe (1Password, etc.)

You now have:
- An **Access Key ID** like `AKIA...`
- A **Secret Access Key** like `wJa...` (only on the CSV)

## 5. Install the AWS CLI

**macOS:**
```bash
brew install awscli
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt-get install -y awscli
# or, for the latest:
# curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
# unzip awscliv2.zip && sudo ./aws/install
```

**Windows:** download the MSI from <https://awscli.amazonaws.com/AWSCLIV2.msi>.

Verify:
```bash
aws --version
```

## 6. Configure the CLI

```bash
aws configure
```

Paste the values from your CSV when prompted:

- `AWS Access Key ID`: `AKIA...`
- `AWS Secret Access Key`: `wJa...`
- `Default region name`: `us-east-1`
- `Default output format`: `json`

This writes to `~/.aws/credentials` and `~/.aws/config`. The Node AWS SDK we'll use in PR #7 reads from those files automatically — no env vars needed.

## 7. Sanity-check Bedrock access

```bash
# Confirm credentials work
aws sts get-caller-identity
# → should print { "Account": "...", "UserId": "...", "Arn": "...local-dev" }

# List Claude models in your region
aws bedrock list-foundation-models --region us-east-1 \
  --query 'modelSummaries[?contains(modelId, `claude`)].modelId' \
  --output table
```

If the second command returns an empty list, **you haven't enabled model access yet.** Do this:

Console → **Bedrock** → **Model access** (left sidebar) → **Modify model access** → check the boxes for **Claude Haiku 4.5**, **Claude Sonnet 4.6**, **Claude Opus 4.7** under Anthropic → **Submit**.

Personal accounts get approved instantly. Re-run the `list-foundation-models` command and you should see them.

Try a real call:

```bash
aws bedrock-runtime converse \
  --region us-east-1 \
  --model-id us.anthropic.claude-haiku-4-5-20251001-v1:0 \
  --messages '[{"role":"user","content":[{"text":"Say hello in five words."}]}]' \
  --query 'output.message.content[0].text' \
  --output text
```

If you see a five-word hello, you're done. The repo's `BEDROCK_CLIENT=real` will work as soon as PR #7 lands.

## 8. Connect the repo to your AWS

In `apps/web/.env.local`:

```
BEDROCK_CLIENT=real
AWS_REGION=us-east-1
```

`AWS_REGION` is the only AWS env var the Node SDK needs from your shell — the credentials come from `~/.aws/credentials` automatically. (No `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` env vars in `.env.local` — keeping secrets out of files you might `git add` by mistake.)

Restart `pnpm dev` and your `/chat` page now talks to real Claude.

---

## What this does *not* set up yet

- Terraform / ECS / RDS / CloudFront — those land in PR #8. You'll create a tighter-scoped IAM user for Terraform then.
- KMS key for encrypted token storage — PR #10 (Graph integration).
- IAM OIDC role for GitHub Actions deploy — PR #11.

For now, all you have is a credential pair that lets your laptop call Bedrock. That's enough for everything through PR #7.

## If something breaks

| Symptom | Likely cause |
|---|---|
| `Unable to locate credentials` | `aws configure` wasn't run, or you're in the wrong shell |
| `AccessDeniedException` on Bedrock | Step 7 model-access form not submitted, or wrong region |
| `ValidationException: model not found` | Wrong `modelId` string. Use the exact ID from `list-foundation-models`. PR #3's `packages/agent/src/models.ts` has them but verify. |
| `ThrottlingException` | First-time accounts have very low Bedrock quotas. Request a limit increase via Service Quotas if needed. Personal use almost never hits it. |
| Surprise charge | Should not happen if step 2 (zero-spend budget) is in place. If it does, kill the IAM key in IAM → Users → Security credentials → Deactivate. |

## Costs to expect

For personal MVP testing while building:

- **Bedrock**: $0 idle. ~$0.005–0.05 per chat depending on length. With prompt caching on (PR #7 enables it), $5–20/mo for normal solo testing.
- **Everything else**: $0 until PR #8 deploys infrastructure.

PLAN.md has the full personal vs. production breakdown.
