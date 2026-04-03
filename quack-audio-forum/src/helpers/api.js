export async function request(url) {
  const res = await fetch(url);
  return res.json();
}
