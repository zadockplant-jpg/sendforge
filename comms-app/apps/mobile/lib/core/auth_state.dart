import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class AuthState extends ChangeNotifier {
  static const _storage = FlutterSecureStorage();
  static const _tokenKey = 'auth_token';

  String? _token;
  bool _initialized = false;

  bool get isLoggedIn => _token != null;
  bool get isInitialized => _initialized;
  String? get token => _token;

  Future<void> load() async {
    _token = await _storage.read(key: _tokenKey);
    _initialized = true;
    notifyListeners();
  }

  Future<void> login(String token) async {
    _token = token;
    await _storage.write(key: _tokenKey, value: token);
    notifyListeners();
  }

  Future<void> logout() async {
    _token = null;
    await _storage.delete(key: _tokenKey);
    notifyListeners();
  }
}
