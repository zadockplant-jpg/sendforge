import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

class ApiClient {
  final String baseUrl;

  ApiClient({required this.baseUrl});

  Future<String?> getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('token');
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

  Future<Map<String, dynamic>> postJson(String path, Map<String, dynamic> body) async {
    final uri = Uri.parse('$baseUrl$path');
    final res = await http.post(uri, headers: await _headers(), body: jsonEncode(body));

    final decoded = res.body.isEmpty ? {} : jsonDecode(res.body);
    if (res.statusCode >= 400) {
      throw ApiError(message: decoded is Map && decoded['error'] != null ? decoded['error'].toString() : res.body);
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
/*class ApiClient {
  static const String baseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://localhost:3000',
  );

  ApiClient();

  // existing methods unchanged
}
*/