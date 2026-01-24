// apps/mobile/lib/services/blasts_api.dart
import 'api_client.dart';

class BlastsApi {
  final ApiClient client;
  BlastsApi(this.client);

  Future<Map<String, dynamic>> quote({
    required String userId,
    required List<String> recipients,
    required String body,
  }) {
    return client.postJson('/v1/blasts/quote', {
      'userId': userId,
      'recipients': recipients,
      'body': body,
    });
  }

  Future<Map<String, dynamic>> send({
    required String userId,
    required List<String> recipients,
    required String body,
    required Map<String, dynamic> quote,
  }) {
    return client.postJson('/v1/blasts/send', {
      'userId': userId,
      'recipients': recipients,
      'body': body,
      'quote': quote,
    });
  }
}
