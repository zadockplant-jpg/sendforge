import 'dart:convert';
import 'package:http/http.dart' as http;

class AuthService {
  final String baseUrl;
  AuthService(this.baseUrl);

  Future<void> register(String email, String password) async {
    final res = await http.post(
      Uri.parse('$baseUrl/v1/auth/register'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'email': email,
        'password': password,
      }),
    );

    if (res.statusCode != 200) {
      throw Exception('Registration failed');
    }

    final data = jsonDecode(res.body);
    if (data is! Map || data['ok'] != true) {
      throw Exception('Registration failed');
    }
  }

  Future<void> resendVerification(String email) async {
    final res = await http.post(
      Uri.parse('$baseUrl/v1/auth/resend-verification'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'email': email}),
    );

    if (res.statusCode != 200) {
      throw Exception('Resend failed');
    }
  }

  Future<String> login(String email, String password) async {
    final res = await http.post(
      Uri.parse('$baseUrl/v1/auth/login'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'email': email,
        'password': password,
      }),
    );

    final body = res.body.isEmpty ? '{}' : res.body;
    final data = jsonDecode(body);

    if (res.statusCode != 200) {
      // Preserve backend error codes for UI logic
      final err = (data is Map && data['error'] != null) ? data['error'].toString() : 'Login failed';
      throw Exception(err);
    }

    if (data is Map && data['token'] is String && (data['token'] as String).isNotEmpty) {
      return data['token'];
    }

    throw Exception('Login failed');
  }
}