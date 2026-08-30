<?php
declare(strict_types=1);

/**
 * ItMatZip Tools admin API.
 * Login uses one-way PBKDF2 hashes from _auth.json (no plaintext credentials).
 */

require_once __DIR__ . DIRECTORY_SEPARATOR . 'site-config-lib.php';

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header('Cache-Control: no-store, no-cache, must-revalidate');

const AUTH_FILE = __DIR__ . DIRECTORY_SEPARATOR . '_auth.json';
const RATE_FILE = DATA_DIR . DIRECTORY_SEPARATOR . 'login-rate.json';
const OG_MAX_BYTES = 2097152;

const RATE_WINDOW_SEC = 900;
const RATE_MAX_ATTEMPTS = 8;
const SESSION_IDLE_SEC = 43200;

function json_out(array $data, int $code = 200) {
  $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES;
  if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) {
    $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
  }
  $json = json_encode($data, $flags);
  if ($json === false) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"ok":false,"error":"응답을 만들지 못했습니다."}';
    exit;
  }
  http_response_code($code);
  header('Content-Type: application/json; charset=utf-8');
  echo $json;
  exit;
}

function request_action() {
  $action = '';
  if (isset($_GET['action']) && is_string($_GET['action'])) {
    $action = $_GET['action'];
  }
  $raw = file_get_contents('php://input');
  $body = null;
  if (is_string($raw) && $raw !== '') {
    $flags = 0;
    if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) {
      $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
    }
    $decoded = json_decode($raw, true, 512, $flags);
    if (is_array($decoded)) {
      $body = $decoded;
    } elseif (json_last_error() !== JSON_ERROR_NONE) {
      json_out(array('ok' => false, 'error' => '요청을 읽지 못했습니다. 페이지를 새로고침한 뒤 다시 저장해 주세요.'), 400);
    }
  }
  if (is_array($body) && isset($body['action']) && is_string($body['action'])) {
    $action = $body['action'];
  }
  return array($action, is_array($body) ? $body : array());
}

function boot_session() {
  $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || ((isset($_SERVER['SERVER_PORT']) ? (int) $_SERVER['SERVER_PORT'] : 0) === 443);
  session_name('itz_admin');
  session_set_cookie_params(array(
    'lifetime' => 0,
    'path' => '/admin',
    'secure' => $https,
    'httponly' => true,
    'samesite' => 'Strict',
  ));
  session_start();
}

function client_ip() {
  if (!empty($_SERVER['REMOTE_ADDR']) && is_string($_SERVER['REMOTE_ADDR'])) {
    return $_SERVER['REMOTE_ADDR'];
  }
  return '0.0.0.0';
}

function load_auth() {
  $auth = read_json_file(AUTH_FILE);
  if (!is_array($auth)) {
    return null;
  }
  foreach (array('user_hash', 'salt', 'pepper', 'pass_hash', 'iterations') as $key) {
    if (empty($auth[$key])) {
      return null;
    }
  }
  return $auth;
}

function verify_password($password, array $auth) {
  $salt = @hex2bin((string) $auth['salt']);
  $pepper = @hex2bin((string) $auth['pepper']);
  $expected = @hex2bin((string) $auth['pass_hash']);
  if ($salt === false || $pepper === false || $expected === false) {
    return false;
  }
  $iter = (int) $auth['iterations'];
  if ($iter < 100000) {
    $iter = 210000;
  }
  $calc = hash_pbkdf2('sha256', $password, $salt . $pepper, $iter, 32, true);
  return hash_equals($expected, $calc);
}

function load_rate() {
  $data = read_json_file(RATE_FILE);
  return is_array($data) ? $data : array();
}

function save_rate(array $data) {
  write_json_file(RATE_FILE, $data);
}

function prune_rate(array $data, $now) {
  $out = array();
  foreach ($data as $ip => $row) {
    if (!is_array($row) || !isset($row['start'], $row['count'])) {
      continue;
    }
    if (($now - (int) $row['start']) < RATE_WINDOW_SEC) {
      $out[$ip] = $row;
    }
  }
  return $out;
}

function rate_blocked($ip) {
  ensure_data_dir();
  $now = time();
  $data = prune_rate(load_rate(), $now);
  $row = isset($data[$ip]) && is_array($data[$ip]) ? $data[$ip] : array('start' => $now, 'count' => 0);
  if (($now - (int) $row['start']) >= RATE_WINDOW_SEC) {
    $row = array('start' => $now, 'count' => 0);
  }
  return array((int) $row['count'] >= RATE_MAX_ATTEMPTS, $data, $row);
}

function rate_fail($ip) {
  $now = time();
  $pack = rate_blocked($ip);
  $data = $pack[1];
  $row = $pack[2];
  $row['count'] = (int) $row['count'] + 1;
  $data[$ip] = $row;
  save_rate($data);
}

function rate_clear($ip) {
  $now = time();
  $data = prune_rate(load_rate(), $now);
  unset($data[$ip]);
  save_rate($data);
}

function csrf_token() {
  if (empty($_SESSION['csrf']) || !is_string($_SESSION['csrf'])) {
    $_SESSION['csrf'] = bin2hex(random_bytes(32));
  }
  return $_SESSION['csrf'];
}

function require_csrf($body) {
  $sent = '';
  if (isset($_SERVER['HTTP_X_CSRF_TOKEN']) && is_string($_SERVER['HTTP_X_CSRF_TOKEN'])) {
    $sent = $_SERVER['HTTP_X_CSRF_TOKEN'];
  } elseif (isset($body['csrf']) && is_string($body['csrf'])) {
    $sent = $body['csrf'];
  }
  $ok = isset($_SESSION['csrf']) && is_string($_SESSION['csrf']) && hash_equals($_SESSION['csrf'], $sent);
  if (!$ok) {
    json_out(array('ok' => false, 'error' => '세션이 만료되었습니다. 다시 로그인해 주세요.'), 403);
  }
}

function logged_in() {
  if (empty($_SESSION['auth_ok']) || $_SESSION['auth_ok'] !== true) {
    return false;
  }
  $now = time();
  $last = isset($_SESSION['last']) ? (int) $_SESSION['last'] : 0;
  if ($last > 0 && ($now - $last) > SESSION_IDLE_SEC) {
    $_SESSION = array();
    return false;
  }
  $_SESSION['last'] = $now;
  return true;
}

function require_login() {
  if (!logged_in()) {
    json_out(array('ok' => false, 'error' => '로그인이 필요합니다.'), 401);
  }
}

function og_target_prefix($target) {
  if ($target === 'hub') {
    return 'hub';
  }
  if (in_array($target, ALLOWED_TOOL_IDS, true)) {
    return $target;
  }
  return '';
}

function og_ext_from_upload($tmp, $name) {
  $ext = strtolower(pathinfo((string) $name, PATHINFO_EXTENSION));
  $ok = array('png' => true, 'jpg' => true, 'jpeg' => true, 'webp' => true);
  if (!isset($ok[$ext])) {
    return '';
  }
  if (function_exists('finfo_open')) {
    $f = finfo_open(FILEINFO_MIME_TYPE);
    $mime = $f ? finfo_file($f, $tmp) : '';
    if ($f) {
      finfo_close($f);
    }
    $allowed = array(
      'image/png' => true,
      'image/jpeg' => true,
      'image/webp' => true,
    );
    if (!is_string($mime) || !isset($allowed[$mime])) {
      return '';
    }
    if ($mime === 'image/jpeg' && $ext === 'png') {
      return '';
    }
  }
  return $ext === 'jpeg' ? 'jpg' : $ext;
}

function delete_og_prefix($prefix) {
  if ($prefix === '' || !is_dir(OG_FS_DIR)) {
    return;
  }
  $files = glob(OG_FS_DIR . DIRECTORY_SEPARATOR . $prefix . '-*.*');
  if (!is_array($files)) {
    return;
  }
  foreach ($files as $file) {
    if (is_file($file)) {
      @unlink($file);
    }
  }
}

list($action, $body) = request_action();
if ($action === '' && isset($_POST['action']) && is_string($_POST['action'])) {
  $action = $_POST['action'];
}

if ($action === 'public') {
  json_out(array('ok' => true, 'config' => public_config()));
}

boot_session();

if ($action === 'session') {
  if (!logged_in()) {
    json_out(array('ok' => false, 'loggedIn' => false), 401);
  }
  json_out(array(
    'ok' => true,
    'loggedIn' => true,
    'csrf' => csrf_token(),
    'config' => public_config(),
  ));
}

if ($action === 'logout') {
  require_csrf($body);
  $_SESSION = array();
  if (ini_get('session.use_cookies')) {
    $p = session_get_cookie_params();
    setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
  }
  session_destroy();
  json_out(array('ok' => true));
}

if ($action === 'login') {
  if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(array('ok' => false, 'error' => '허용되지 않은 요청입니다.'), 405);
  }
  $ip = client_ip();
  $blocked = rate_blocked($ip);
  if ($blocked[0]) {
    json_out(array('ok' => false, 'error' => '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.'), 429);
  }

  $username = isset($body['username']) && is_string($body['username']) ? $body['username'] : '';
  $password = isset($body['password']) && is_string($body['password']) ? $body['password'] : '';
  $auth = load_auth();
  $ok = false;
  if ($auth !== null) {
    $user_hash = hash('sha256', $username);
    $user_ok = hash_equals((string) $auth['user_hash'], $user_hash);
    $pass_ok = verify_password($password, $auth);
    $ok = $user_ok && $pass_ok;
  }
  if (!$ok) {
    rate_fail($ip);
    json_out(array('ok' => false, 'error' => '아이디 또는 비밀번호가 올바르지 않습니다.'), 401);
  }

  rate_clear($ip);
  session_regenerate_id(true);
  $_SESSION['auth_ok'] = true;
  $_SESSION['last'] = time();
  $_SESSION['csrf'] = bin2hex(random_bytes(32));
  json_out(array(
    'ok' => true,
    'csrf' => $_SESSION['csrf'],
    'config' => public_config(),
  ));
}

if ($action === 'save') {
  if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(array('ok' => false, 'error' => '허용되지 않은 요청입니다.'), 405);
  }
  require_login();
  require_csrf($body);
  $incoming = isset($body['config']) && is_array($body['config']) ? $body['config'] : null;
  if ($incoming === null) {
    json_out(array('ok' => false, 'error' => '설정 데이터가 없습니다. 페이지를 새로고침한 뒤 다시 저장해 주세요.'), 400);
  }
  $existing = public_config();
  if (!isset($incoming['hub']) && isset($existing['hub'])) {
    $incoming['hub'] = $existing['hub'];
  }
  if (!isset($incoming['legal']) && isset($existing['legal'])) {
    $incoming['legal'] = $existing['legal'];
  }
  $tools_in = isset($incoming['tools']) && is_array($incoming['tools']) ? $incoming['tools'] : null;
  if (($tools_in === null || count($tools_in) === 0)
    && isset($existing['tools']) && is_array($existing['tools']) && count($existing['tools']) > 0) {
    $incoming['tools'] = $existing['tools'];
  }
  $cfg = normalize_config($incoming);
  $cfg['updatedAt'] = time();
  ensure_data_dir();
  if (!write_json_file(RUNTIME_CONFIG_FILE, $cfg)) {
    json_out(array('ok' => false, 'error' => '설정을 저장하지 못했습니다.'), 500);
  }
  json_out(array('ok' => true, 'config' => $cfg, 'csrf' => csrf_token()));
}

if ($action === 'upload-og') {
  if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(array('ok' => false, 'error' => '허용되지 않은 요청입니다.'), 405);
  }
  require_login();
  require_csrf($_POST);
  $target = isset($_POST['target']) && is_string($_POST['target']) ? trim($_POST['target']) : '';
  $prefix = og_target_prefix($target);
  if ($prefix === '') {
    json_out(array('ok' => false, 'error' => '올바르지 않은 대상입니다.'), 400);
  }
  if (empty($_FILES['og']) || !is_array($_FILES['og'])) {
    json_out(array('ok' => false, 'error' => '이미지 파일이 없습니다.'), 400);
  }
  $file = $_FILES['og'];
  if (!isset($file['error']) || (int) $file['error'] !== UPLOAD_ERR_OK) {
    json_out(array('ok' => false, 'error' => '이미지를 받지 못했습니다.'), 400);
  }
  if ((int) $file['size'] > OG_MAX_BYTES) {
    json_out(array('ok' => false, 'error' => '이미지는 2MB 이하여야 합니다.'), 400);
  }
  $tmp = isset($file['tmp_name']) ? (string) $file['tmp_name'] : '';
  if ($tmp === '' || !is_uploaded_file($tmp)) {
    json_out(array('ok' => false, 'error' => '이미지를 받지 못했습니다.'), 400);
  }
  $ext = og_ext_from_upload($tmp, (string) ($file['name'] ?? ''));
  if ($ext === '') {
    json_out(array('ok' => false, 'error' => 'PNG, JPG, WebP만 올릴 수 있습니다.'), 400);
  }
  ensure_og_dir();
  delete_og_prefix($prefix);
  $name = $prefix . '-' . bin2hex(random_bytes(4)) . '.' . $ext;
  $dest = OG_FS_DIR . DIRECTORY_SEPARATOR . $name;
  if (!move_uploaded_file($tmp, $dest)) {
    json_out(array('ok' => false, 'error' => '이미지를 저장하지 못했습니다.'), 500);
  }
  json_out(array(
    'ok' => true,
    'url' => '/' . OG_PUBLIC_DIR . '/' . $name,
    'csrf' => csrf_token(),
  ));
}

json_out(array('ok' => false, 'error' => '알 수 없는 요청입니다.'), 400);
