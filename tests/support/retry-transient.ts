export async function retryTransient(
  request: () => Promise<Response>,
  attempts = 8,
): Promise<Response> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await request();
    if (response.status !== 503 || attempt === attempts - 1) {
      return response;
    }
    await response.arrayBuffer();
    await Bun.sleep(1000);
  }
  throw new Error('limite de tentativas inválido');
}
