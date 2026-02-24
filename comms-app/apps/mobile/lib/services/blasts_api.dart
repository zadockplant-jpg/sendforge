// comms-app/apps/mobile/lib/services/blasts_api.dart
import 'api_client.dart';

class BlastsApi {
  final ApiClient client;
  BlastsApi(this.client);

  Future<Map<String, dynamic>> quote({
    required List<String> groupIds,
    required List<String> channels, // ["sms","email"]
    required String body,
  }) {
    return client.postJson('/v1/blasts/quote', {
      'groupIds': groupIds,
      'channels': channels,
      'body': body,
    });
  }

  Future<Map<String, dynamic>> send({
    required List<String> groupIds,
    required List<String> channels,
    required String body,
    required Map<String, dynamic> quote,
  }) {
    return client.postJson('/v1/blasts/send', {
      'groupIds': groupIds,
      'channels': channels,
      'body': body,
      'quote': quote,
    });
  }
}