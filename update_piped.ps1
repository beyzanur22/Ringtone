$file = 'C:\Users\beyza\Desktop\ringtone-backend-deploy\server.js'
$text = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)

# Lower timeout from 6000 to 2000, and randomize array so they don't all hit a dead server first
$pipedOrig = 'async function fetchFromPiped(endpointPath) {
  let lastError = null;
  for (const instance of PIPED_INSTANCES) {
    try {
      const res = await axiosClient.get($(${instance}), { timeout: 6000 });'

$pipedNew = 'async function fetchFromPiped(endpointPath) {
  let lastError = null;
  // Shuffle PIPED_INSTANCES to load balance and avoid dead server bottlenecks
  const shuffledInstances = [...PIPED_INSTANCES].sort(() => 0.5 - Math.random());
  for (const instance of shuffledInstances) {
    try {
      const res = await axiosClient.get($(${instance}), { timeout: 2000 });'

$text = $text -replace [regex]::Escape($pipedOrig), $pipedNew

[System.IO.File]::WriteAllText($file, $text, [System.Text.Encoding]::UTF8)