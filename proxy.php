<?php
header("Content-Type: application/json; charset=utf-8");

try {
  if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Método no permitido']);
    exit;
  }

  $raw = file_get_contents("php://input");
  $json = json_decode($raw, true);
  if (!is_array($json)) {
    http_response_code(400);
    echo json_encode(['error' => 'JSON inválido']);
    exit;
  }

  $task = $json['task'] ?? '';
  $image = $json['image'] ?? null;
  $prompt = $json['prompt'] ?? null;
  $prompts = $json['prompts'] ?? null;

  $apiKey = getenv('C');
  if (!$apiKey && isset($_SERVER['GOOGLE_API_KEY'])) $apiKey = $_SERVER['GOOGLE_API_KEY'];
  if (!$apiKey) {
    http_response_code(500);
    echo json_encode(['error' => 'Falta GOOGLE_API_KEY en entorno del servidor']);
    exit;
  }

  function call_gemini($model, $body, $apiKey) {
    $url = "https://generativelanguage.googleapis.com/v1beta/models/{$model}:generateContent?key=" . urlencode($apiKey);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
      CURLOPT_RETURNTRANSFER => true,
      CURLOPT_POST => true,
      CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
      CURLOPT_POSTFIELDS => json_encode($body),
      CURLOPT_TIMEOUT => 120,
    ]);
    $resp = curl_exec($ch);
    if ($resp === false) throw new Exception("cURL: " . curl_error($ch));
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $data = json_decode($resp, true);
    if ($status < 200 || $status >= 300) {
      $msg = $data['error']['message'] ?? ("HTTP " . $status);
      throw new Exception($msg);
    }
    return $data;
  }

  if ($task === 'describe') {
    $body = [
      "contents" => [[
        "parts" => [
          ["inlineData" => ["data" => $image['data'], "mimeType" => $image['mimeType']]],
          ["text" => $prompt ?: "Describe el producto en español, máximo 1000 caracteres."]
        ]
      ]]
    ];
    $data = call_gemini("gemini-3.1-flash-image-preview", $body, $apiKey);
    $text = $data['candidates'][0]['content']['parts'][0]['text'] ?? null;
    if (!$text) throw new Exception("Sin descripción");
    echo json_encode(['description' => $text], JSON_UNESCAPED_UNICODE);
    exit;
  }

  if ($task === 'generateImages') {
    if (!is_array($prompts)) $prompts = [];
    $images = [];
    foreach ($prompts as $p) {
      $body = [
        "contents" => [[
          "parts" => [
            ["inlineData" => ["data" => $image['data'], "mimeType" => $image['mimeType']]],
            ["text" => $p]
          ]
        ]]
      ];
      $data = call_gemini("gemini-3-pro-image-preview", $body, $apiKey);
      $parts = $data['candidates'][0]['content']['parts'] ?? [];
      foreach ($parts as $part) {
        if (isset($part['inlineData']['data'])) {
          $images[] = [
            'data' => $part['inlineData']['data'],
            'mimeType' => $part['inlineData']['mimeType'] ?? 'image/png'
          ];
          break;
        }
      }
    }
    echo json_encode(['images' => $images]);
    exit;
  }

  http_response_code(400);
  echo json_encode(['error' => 'task inválida']);
} catch (Throwable $e) {
  http_response_code(500);
  echo json_encode(['error' => $e->getMessage()]);
}
