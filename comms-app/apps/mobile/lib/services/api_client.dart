import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class ApiClient {
  final String baseUrl;

  static const _storage = FlutterSecureStorage();
  static const _tokenKey = 'auth_token';

  ApiClient({required this.baseUrl});

  Future<void> setToken(String token) async {
    await _storage.write(key: _tokenKey, value: token);
  }

  Future<void> clearToken() async {
    await _storage.delete(key: _tokenKey);
  }

  Future<String?> getToken() async {
    return await _storage.read(key: _tokenKey);
  }

  Future<Map<String, String>> _headers() async {
    final token = await getToken();

    final h = <String, String>{
      'Content-Type': 'application/json',
    };

    if (token != null && token.isNotEmpty) {
      h['Authorization'] = 'Bearer $token';
    }

    return h;
  }

  Uri _u(String path) => Uri.parse('$baseUrl$path');

  Map<String, dynamic> _decode(http.Response res) {
    if (res.body.isEmpty) return <String, dynamic>{};
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return <String, dynamic>{'data': decoded};
  }

  Never _throw(http.Response res, Map<String, dynamic> decoded) {
    final msg = decoded['error']?.toString() ?? res.body;
    throw ApiError(message: msg);
  }

  Future<Map<String, dynamic>> getJson(String path) async {
    final res = await http.get(_u(path), headers: await _headers());
    final decoded = _decode(res);
    if (res.statusCode >= 400) _throw(res, decoded);
    return decoded;
  }

  Future<Map<String, dynamic>> postJson(String path, Map<String, dynamic> body) async {
    final res = await http.post(
      _u(path),
      headers: await _headers(),
      body: jsonEncode(body),
    );
    final decoded = _decode(res);
    if (res.statusCode >= 400) _throw(res, decoded);
    return decoded;
  }

  Future<Map<String, dynamic>> putJson(String path, Map<String, dynamic> body) async {
    final res = await http.put(
      _u(path),
      headers: await _headers(),
      body: jsonEncode(body),
    );
    final decoded = _decode(res);
    if (res.statusCode >= 400) _throw(res, decoded);
    return decoded;
  }

  Future<Map<String, dynamic>> deleteJson(String path) async {
    final res = await http.delete(_u(path), headers: await _headers());
    final decoded = _decode(res);
    if (res.statusCode >= 400) _throw(res, decoded);
    return decoded;
  }
}

class ApiError implements Exception {
  final String message;
  ApiError({required this.message});
  @override
  String toString() => message;
}