# GitHub Copilot Instructions - Kooker Platform

## Project Context
This is part of the Kooker ecosystem, a microservices-based platform for meal planning and management.

## Architecture
- **Pattern:** Microservices architecture with Spring Cloud + Node.js Edge Services
- **Service Discovery:** Netflix Eureka
- **Configuration:** Spring Cloud Config Server  
- **API Gateway:** Spring Cloud Gateway (Reactive)
- **Authentication:** JWT-based with refresh token rotation
- **Observability:** Loki (logs), Tempo/Jaeger (traces), Prometheus (metrics), Grafana (dashboards)
- **Infrastructure:** Local Kind Kubernetes Cluster managed by ArgoCD (GitOps)

## Code Standards

### Node.js / Vanilla Frontend
- Use strict HTML sanitization (e.g., `escapeHtml`) when rendering any user data via `innerHTML` to prevent XSS.
- Rely on modern ES6 features but avoid heavy frameworks (React/Angular) unless explicitly defined in the project.
- Backends use Express.js. Validate API data locally (e.g., missing `sessionSecret`) before attempting outbound validation.

### GitOps & CI/CD Infrastructure
- CI/CD pipelines use GitHub Actions to publish `ghcr.io` images.
- Images deployed via ArgoCD must ALWAYS use strict semver tags (e.g., `v1.2.3`). NEVER use the `latest` tag in Kustomize.
- Application versions in `package.json` or `pom.xml` are synced by automated GitHub Actions CI pipeline bumps.
- Avoid bypassing architectural networking boundaries; all frontend microservices must route exclusively through the `kooker-gateway`.

### Java/Spring Boot
- Use Java 17+ features (records, sealed classes, pattern matching)
- Follow Spring Boot 3.x best practices
- Use constructor injection (via Lombok `@RequiredArgsConstructor`)
- Implement proper exception handling with `@RestControllerAdvice`
- Add structured logging with SLF4J and Logback
- Use Lombok for boilerplate reduction
- Follow RESTful API conventions with proper HTTP semantics

### API Design
- **Path naming:** Use dash-notation (kebab-case): `/api/v1/user-profile`, `/api/v1/meal-plan`
- **HTTP methods:** GET (read), POST (create), PUT (full update), PATCH (partial update), DELETE
- **Response codes:** 200 (OK), 201 (Created), 204 (No Content), 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found), 500 (Server Error)
- **Error responses:** Consistent schema with `code`, `message`, `details`, `correlationId`, `timestamp`
- **Versioning:** Use base path `/api/v1/` for all endpoints; increment version for breaking changes
- **Pagination:** Use `page`, `size`, `sort` query parameters; return `Page<T>` or custom wrapper
- **Filtering:** Use query parameters: `/api/v1/users?status=active&role=admin`

### Metrics & Observability

#### Prometheus Metrics (Micrometer) - CRITICAL RULES
- **ALWAYS use aggregate metrics** - DO NOT add high-cardinality labels
- **HIGH CARDINALITY = BAD:** Never use `userId`, `email`, `sessionId`, `deviceId`, or any user-specific data as metric labels
- **Good labels:** `service`, `environment`, `endpoint`, `status`, `reason` (with < 10 unique values)
- **Naming convention:**
  - Counters: `*_total` suffix (e.g., `refresh_token_created_total`)
  - Gauges: No suffix (e.g., `active_sessions_count`)
  - Histograms: `_seconds` or `_bytes` suffix (e.g., `http_request_duration_seconds`)
- **User context:** Log with context (userId, etc.) but NEVER add to metric tags
- **Example - CORRECT:**
  ```java
  Counter.builder("refresh_token_reuse_detected_total")
      .description("Total token reuse detections")
      .tag("service", "auth-service")
      .register(registry)
      .increment();
  
  // Log with user context for investigation
  log.warn("SECURITY: Token reuse - userId={}, deviceId={}", userId, deviceId);
  ```

- **Example - WRONG (DO NOT DO THIS):**
  ```java
  // WRONG: userId creates unbounded cardinality!
  Counter.builder("token_reuse")
      .tag("user_id", userId.toString())  // ❌ NO!
      .register(registry);
  ```

#### Distributed Tracing
- Use Micrometer Tracing with OTLP exporter
- Trace IDs automatically propagated via W3C Trace Context headers
- Add custom spans for critical operations: `@NewSpan("operation-name")`
- Include trace ID in logs via MDC (automatic with Spring Boot 3)

#### Structured Logging
- Use JSON format with `logstash-logback-encoder` for file logs
- Include: `timestamp`, `level`, `logger_name`, `message`, `thread_name`, `traceId`, `spanId`
- Log levels:
  - **ERROR:** System failures requiring immediate attention
  - **WARN:** Expected client errors (e.g., validation failures, missing auth)
  - **INFO:** Business events (user created, order placed)
  - **DEBUG:** Technical details for troubleshooting
- **Authentication filter logging:** Use WARN or DEBUG for missing auth headers (not ERROR)

### Security
- Never commit secrets or credentials
- Use environment variables for sensitive data (via Config Server or `.env`)
- Implement proper input validation with `@Valid` and custom validators
- Follow OWASP security best practices
- JWT tokens: 30min access + 30day refresh with rotation
- Hash sensitive data in logs if unavoidable
- **Refresh Token Security:**
  - Detect token reuse → revoke all user sessions
  - Record security metrics (aggregate only, no user PII in labels)
  - Log detailed context for investigation

### Exception Handling
- Use `ResponseStatusException` for business logic errors
- Implement `@RestControllerAdvice` for global exception handling
- Return consistent error schema:
  ```json
  {
    "status": 400,
    "error": "Bad Request",
    "message": "User-friendly message",
    "details": ["field1: validation error"],
    "correlationId": "uuid",
    "timestamp": "2026-01-27T22:00:00Z"
  }
  ```
- Add correlation ID from `X-Correlation-ID` header or generate new UUID

### Testing
- Write unit tests for business logic (use JUnit 5, Mockito)
- Implement integration tests for APIs (use `@SpringBootTest`, `@AutoConfigureMockMvc`)
- Test security configurations with `@WithMockUser`
- Test metrics recording in unit tests (verify counter increments)
- Aim for > 80% code coverage on critical paths
- Test edge cases and error conditions

### Documentation
- Document public APIs with OpenAPI/Swagger annotations
- Keep README files up to date with setup instructions
- Document architectural decisions in ADR files (AsciiDoc format)
- Use PlantUML for diagrams with `!theme plain`
- Include sequence diagrams for complex flows
- Maintain changelog for releases

### Dependency Management
- Use `kooker-bom` for consistent versioning across services
- Keep dependencies up to date (Renovate handles this)
- Minimize dependency footprint
- Avoid conflicting dependencies
- Check BOM before adding new dependencies

## Observability Integration

### Required Dependencies
```xml
<!-- Metrics -->
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-registry-prometheus</artifactId>
</dependency>

<!-- Tracing (optional but recommended) -->
<dependency>
    <groupId>io.micrometer</groupId>
    <artifactId>micrometer-tracing-bridge-otel</artifactId>
</dependency>
<dependency>
    <groupId>io.opentelemetry</groupId>
    <artifactId>opentelemetry-exporter-otlp</artifactId>
</dependency>

<!-- Structured logging -->
<dependency>
    <groupId>net.logstash.logback</groupId>
    <artifactId>logstash-logback-encoder</artifactId>
</dependency>
```

### Application Configuration
```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics,prometheus
  metrics:
    tags:
      application: ${spring.application.name}
      environment: ${spring.profiles.active}
  tracing:
    sampling:
      probability: 1.0  # 100% in dev, lower in prod
  otlp:
    tracing:
      endpoint: http://localhost:4318/v1/traces
```

### Accessing Observability Tools
- **Grafana:** http://localhost:3000 (admin/admin)
- **Jaeger UI:** http://localhost:16686
- **Prometheus:** http://localhost:9090
- **CLI:** `./search-logs.sh help`

## Common Pitfalls to Avoid
1. **High-cardinality metrics:** Never use unbounded values (userId, etc.) as metric labels
2. **Blocking in reactive code:** Don't use blocking operations in Gateway filters
3. **Missing correlation IDs:** Always propagate/generate correlation IDs
4. **Logging sensitive data:** Never log passwords, tokens, or PII
5. **Hardcoded config:** Use Config Server or environment variables
6. **Missing validation:** Always validate input DTOs with `@Valid`
7. **Inconsistent error responses:** Use global exception handler

## Key Reference Documents
- `OBSERVABILITY-QUICK-START.adoc` - Complete observability guide
- `HOW-TO-SEARCH-LOGS.adoc` - Practical log searching
- `REFRESH-TOKEN-METRICS-ADR.adoc` - Metrics architecture

## Related Repositories
All services in `/home/kooker/source/`:
- `kooker-service-auth` - Authentication & JWT
- `kooker-service-user` - User management
- `kooker-service-stream` - Activity streams
- `kooker-gateway` - API Gateway
- `kooker-discovery-service` - Eureka
- `kooker-config-server` - Config Server
- `kooker-infrastructure` - Observability stack
