import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class ApiClient {
  final String baseUrl;

  static const _storage = FlutterSecureStorage();
  static const _tokenKey = 'auth_token';

  ApiClient({required this.baseUrl});

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

  Future<Map<String, dynamic>> getJson(String path) async {
    final uri = Uri.parse('$baseUrl$path');
    final res = await http.get(uri, headers: await _headers());

    final decoded = res.body.isEmpty ? {} : jsonDecode(res.body);

    if (res.statusCode >= 400) {
      throw ApiError(
        message: decoded is Map && decoded['error'] != null
            ? decoded['error'].toString()
            : res.body,
      );
    }

    return (decoded as Map<String, dynamic>);
  }

  Future<Map<String, dynamic>> postJson(
      String path, Map<String, dynamic> body) async {
    final uri = Uri.parse('$baseUrl$path');

    final res = await http.post(
      uri,
      headers: await _headers(),
      body: jsonEncode(body),
    );

    final decoded = res.body.isEmpty ? {} : jsonDecode(res.body);

    if (res.statusCode >= 400) {
      throw ApiError(
        message: decoded is Map && decoded['error'] != null
            ? decoded['error'].toString()
            : res.body,
      );
    }

    return (decoded as Map<String, dynamic>);
  }

  // ✅ Added to match backend PUT routes
  Future<Map<String, dynamic>> putJson(
      String path, Map<String, dynamic> body) async {
    final uri = Uri.parse('$baseUrl$path');

    final res = await http.put(
      uri,
      headers: await _headers(),
      body: jsonEncode(body),
    );

    final decoded = res.body.isEmpty ? {} : jsonDecode(res.body);

    if (res.statusCode >= 400) {
      throw ApiError(
        message: decoded is Map && decoded['error'] != null
            ? decoded['error'].toString()
            : res.body,
      );
    }

    return (decoded as Map<String, dynamic>);
  }
}

class ApiError implements Exception {
  final String message;
  ApiError({required this.message});

  @override
  String toString() => message;
}