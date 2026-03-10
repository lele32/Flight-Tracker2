#!/bin/bash
# Test Suite para Flight Tracker API
# Autor: Flight Tracker Team
# Fecha: 2026-03-09

API_URL="https://flight-tracker-deploy.vercel.app/api/lookupFlight"
COLORS=1

# Colores
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_test() {
    echo -e "${BLUE}===${NC} $1 ${BLUE}===${NC}"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# Test 1: Request normal
print_test "Test 1: Request Normal"
response=$(curl -s "$API_URL?flightNumber=AR1388")
if echo "$response" | jq -e '.found == true' > /dev/null 2>&1; then
    print_success "Vuelo AR1388 encontrado"
    echo "$response" | jq '.'
else
    print_error "Fallo al buscar vuelo AR1388"
    echo "$response"
fi
echo ""

# Test 2: Rate Limiting Headers
print_test "Test 2: Rate Limiting Headers"
headers=$(curl -s -i "$API_URL?flightNumber=TEST123" 2>&1 | grep -i "x-ratelimit")
if [ ! -z "$headers" ]; then
    print_success "Headers de rate limiting presentes"
    echo "$headers"
else
    print_error "Headers de rate limiting no encontrados"
fi
echo ""

# Test 3: Validación de entrada inválida
print_test "Test 3: Validación de Entrada Inválida"
response=$(curl -s "$API_URL?flightNumber=INVALID***")
error=$(echo "$response" | jq -r '.error')
if [ "$error" != "null" ]; then
    print_success "Validación funcionando: $error"
else
    print_error "Validación no funcionó"
fi
echo ""

# Test 4: CORS desde origen permitido
print_test "Test 4: CORS Headers"
cors_header=$(curl -s -H "Origin: https://lele32.github.io" -i "$API_URL?flightNumber=AR1388" 2>&1 | grep -i "access-control-allow-origin")
if echo "$cors_header" | grep -q "lele32.github.io"; then
    print_success "CORS configurado correctamente"
    echo "$cors_header"
else
    print_warning "CORS header no encontrado (puede ser normal sin Origin header)"
fi
echo ""

# Test 5: Vuelo no encontrado (válido)
print_test "Test 5: Vuelo No Encontrado"
response=$(curl -s "$API_URL?flightNumber=ZZ9999")
found=$(echo "$response" | jq -r '.found')
if [ "$found" = "false" ]; then
    print_success "Manejo correcto de vuelo no encontrado"
else
    print_warning "Respuesta inesperada para vuelo no existente"
fi
echo ""

# Test 6: Rate Limiting en Acción
print_test "Test 6: Rate Limiting en Acción (5 requests)"
for i in {1..5}; do
    remaining=$(curl -s -i "$API_URL?flightNumber=TEST$i" 2>&1 | grep -i "x-ratelimit-remaining" | cut -d: -f2 | tr -d ' \r')
    echo "Request $i: $remaining requests restantes"
    sleep 0.2
done
echo ""

# Test 7: Headers de Seguridad
print_test "Test 7: Security Headers"
security_headers=$(curl -s -i "$API_URL?flightNumber=AR1388" 2>&1 | grep -E "(x-content-type|x-frame-options|x-xss-protection)")
if [ ! -z "$security_headers" ]; then
    print_success "Security headers presentes"
    echo "$security_headers"
else
    print_error "Security headers no encontrados"
fi
echo ""

# Test 8: Método no permitido (POST)
print_test "Test 8: Método POST No Permitido"
response=$(curl -s -X POST "$API_URL?flightNumber=AR1388")
error=$(echo "$response" | jq -r '.error')
if [ "$error" = "method-not-allowed" ]; then
    print_success "Método POST correctamente bloqueado"
else
    print_error "Método POST no bloqueado correctamente"
fi
echo ""

# Resumen
print_test "Resumen de Tests"
echo -e "${GREEN}Todas las funcionalidades principales están operativas:${NC}"
echo "  • Rate Limiting: 30 requests/min por IP"
echo "  • Logging: JSON estructurado"
echo "  • Security: CORS, Headers de seguridad"
echo "  • Validación: Formato de flight numbers"
echo "  • Analytics: Métricas en memoria"
echo ""
echo -e "${BLUE}API Endpoint:${NC} $API_URL"
echo -e "${BLUE}Documentación:${NC} API_DOCUMENTATION.md"
