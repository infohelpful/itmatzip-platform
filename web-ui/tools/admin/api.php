<?php
declare(strict_types=1);

/**
 * ItMatZip Tools admin API.
 * Login uses one-way PBKDF2 hashes from _auth.json (no plaintext credentials).
 */

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header('Cache-Control: no-store, no-cache, must-revalidate');

const AUTH_FILE = __DIR__ . DIRECTORY_SEPARATOR . '_auth.json';
const DEFAULT_CONFIG_FILE = __DIR__ . DIRECTORY_SEPARATOR . 'site-config.json';
const DATA_DIR = __DIR__ . DIRECTORY_SEPARATOR . 'data';
const RUNTIME_CONFIG_FILE = DATA_DIR . DIRECTORY_SEPARATOR . 'site-config.json';
const RATE_FILE = DATA_DIR . DIRECTORY_SEPARATOR . 'login-rate.json';

const ALLOWED_TOOL_IDS = array(
  'silence-remover',
  'auto-subtitle',
  'vocal-remover',
  'image-enhancer',
  'background-remover',
  'create-music',
  'magic-eraser',
  'voice-changer',
  'watermark-remover',
  'thumbnail-grabber',
  'ico-maker',
  'unattend-maker',
);

const ALLOWED_AD_UNITS = array(
  'dashboardBanner',
  'editorAboveWorkspace',
  'editorBelowExport',
  'downloadTop',
  'downloadBottom',
);

const RATE_WINDOW_SEC = 900;
const RATE_MAX_ATTEMPTS = 8;
const SESSION_IDLE_SEC = 43200;

function json_out(array $data, int $code = 200) {
  http_response_code($code);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($data, JSON_UNESCAPED_UNICODE);
  exit;
}

function request_action() {
  $action = '';
  if (isset($_GET['action']) && is_string($_GET['action'])) {
    $action = $_GET['action'];
  }
  $raw = file_get_contents('php://input');
  $body = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
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

function ensure_data_dir() {
  if (!is_dir(DATA_DIR)) {
    mkdir(DATA_DIR, 0700, true);
  }
}

function read_json_file($path) {
  if (!is_file($path)) {
    return null;
  }
  $raw = file_get_contents($path);
  if (!is_string($raw) || $raw === '') {
    return null;
  }
  $data = json_decode($raw, true);
  return is_array($data) ? $data : null;
}

function write_json_file($path, array $data) {
  $dir = dirname($path);
  if (!is_dir($dir)) {
    mkdir($dir, 0700, true);
  }
  $tmp = $path . '.tmp';
  $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
  if ($json === false) {
    return false;
  }
  if (file_put_contents($tmp, $json . "\n", LOCK_EX) === false) {
    return false;
  }
  return rename($tmp, $path);
}

function default_config() {
  $cfg = read_json_file(DEFAULT_CONFIG_FILE);
  if (!is_array($cfg)) {
    $cfg = array(
      'hiddenToolIds' => array(),
      'adsense' => array(
        'enabled' => true,
        'client' => 'ca-pub-2088466558007407',
        'units' => array(),
      ),
    );
  }
  return $cfg;
}

function public_config() {
  $runtime = read_json_file(RUNTIME_CONFIG_FILE);
  if (is_array($runtime)) {
    return normalize_config($runtime);
  }
  return normalize_config(default_config());
}

function normalize_config(array $cfg) {
  $hidden = array();
  if (isset($cfg['hiddenToolIds']) && is_array($cfg['hiddenToolIds'])) {
    foreach ($cfg['hiddenToolIds'] as $id) {
      if (is_string($id) && in_array($id, ALLOWED_TOOL_IDS, true)) {
        $hidden[] = $id;
      }
    }
  }
  $hidden = array_values(array_unique($hidden));

  $ads = (isset($cfg['adsense']) && is_array($cfg['adsense'])) ? $cfg['adsense'] : array();
  $client = isset($ads['client']) && is_string($ads['client']) ? trim($ads['client']) : '';
  if ($client === '' || !preg_match('/^ca-pub-\d{8,22}$/', $client)) {
    $client = 'ca-pub-2088466558007407';
  }

  $base_units = array();
  $defaults = default_config();
  if (isset($defaults['adsense']['units']) && is_array($defaults['adsense']['units'])) {
    $base_units = $defaults['adsense']['units'];
  }

  $in_units = (isset($ads['units']) && is_array($ads['units'])) ? $ads['units'] : array();
  $units = array();
  foreach (ALLOWED_AD_UNITS as $key) {
    $src = array();
    if (isset($base_units[$key]) && is_array($base_units[$key])) {
      $src = $base_units[$key];
    }
    if (isset($in_units[$key]) && is_array($in_units[$key])) {
      $src = array_merge($src, $in_units[$key]);
    }
    $slot = isset($src['slot']) && is_string($src['slot']) ? trim($src['slot']) : '';
    if ($slot !== '' && !preg_match('/^\d{6,20}$/', $slot)) {
      $slot = '';
    }
    $units[$key] = array(
      'slot' => $slot,
      'adFormat' => isset($src['adFormat']) && is_string($src['adFormat']) ? $src['adFormat'] : 'horizontal',
      'fullWidthResponsive' => !isset($src['fullWidthResponsive']) || (bool) $src['fullWidthResponsive'],
    );
  }

  return array(
    'hiddenToolIds' => $hidden,
    'adsense' => array(
      'enabled' => !isset($ads['enabled']) || (bool) $ads['enabled'],
      'client' => $client,
      'units' => $units,
    ),
  );
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

list($action, $body) = request_action();

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
  $incoming = isset($body['config']) && is_array($body['config']) ? $body['config'] : array();
  $cfg = normalize_config($incoming);
  ensure_data_dir();
  if (!write_json_file(RUNTIME_CONFIG_FILE, $cfg)) {
    json_out(array('ok' => false, 'error' => '설정을 저장하지 못했습니다.'), 500);
  }
  json_out(array('ok' => true, 'config' => $cfg, 'csrf' => csrf_token()));
}

json_out(array('ok' => false, 'error' => '알 수 없는 요청입니다.'), 400);
