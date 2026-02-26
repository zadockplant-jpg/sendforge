import 'api_client.dart';

class AuthService {
  final ApiClient api;
  AuthService(this.api);

  Future<void> login({required String email, required String password}) async {
    final res = await api.postJson('/v1/auth/login', {
      'email': email.trim(),
      'password': password,
    });

    final token = (res['token'] ?? '').toString();
    if (token.isEmpty) throw Exception('missing_token');
    await api.setToken(token);
  }

  Future<void> register({required String email, required String password}) async {
    final res = await api.postJson('/v1/auth/register', {
      'email': email.trim(),
      'password': password,
    });

    final token = (res['token'] ?? '').toString();
    if (token.isEmpty) throw Exception('missing_token');
    await api.setToken(token);
  }

  Future<void> logout() async {
    await api.clearToken();
  }
}