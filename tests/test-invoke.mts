/**
 * .mts（ES Module TypeScript）を使用している理由:
 * トップレベル await（30行目の `await client.send(...)` など）を使うために
 * ES Module 形式が必要なため。
 * .ts のままだと package.json に "type": "module" がない場合に
 * CommonJS として扱われ、トップレベル await がエラーになる。
 */
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore'

// AgentCore クライアントを初期化
const client = new BedrockAgentCoreClient({ region: 'ap-northeast-1' })

// 呼び出すエージェントのARN（環境変数 RUNTIME_ARN で指定）
const agentArn = process.env.RUNTIME_ARN
if (!agentArn) {
  console.error('Error: RUNTIME_ARN environment variable is not set.')
  process.exit(1)
}

// プロンプト（引数で上書き可能）
const prompt = process.argv[2] ?? '何ができる？'

console.log(`Invoking AgentCore Runtime...\nPrompt: ${prompt}\n`)

const payload = JSON.stringify({ prompt })
const command = new InvokeAgentRuntimeCommand({
  agentRuntimeArn: agentArn,
  runtimeSessionId: crypto.randomUUID(),
  payload: new TextEncoder().encode(payload),
  contentType: 'application/json',
  accept: 'text/event-stream',
})

const response = await client.send(command)

// ストリーミングレスポンスを処理
if (response.response) {
  const stream = response.response as AsyncIterable<Buffer>
  for await (const chunk of stream) {
    const text = new TextDecoder().decode(chunk)
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6))
          if (data.text) process.stdout.write(data.text)
        } catch {
          // パースエラーは無視
        }
      }
    }
  }
}
console.log()
